import { eq } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { toFile } from "openai"
import { z } from "zod"
import { db } from "../../db/client.js"
import { conversations, messages } from "../../db/schema.js"
import { HttpError, withErrors } from "../../lib/http.js"
import { enqueue } from "../../lib/jobs.js"
import { openai } from "../../lib/openai.js"
import { modelPrices, recordUsage, tokenCost } from "../../lib/pricing.js"
import { buildInstructions } from "../chat/context.js"
import { toMessage, messageSchema } from "../conversations/routes.js"
import { getConversation } from "../conversations/service.js"
import { getSettings, voices } from "../settings/service.js"

const MAX_AUDIO_BYTES = 25 * 1024 * 1024
/** Fala média em pt-BR: ~900 caracteres por minuto (para estimar o custo do TTS). */
const CHARS_PER_MINUTE = 900

export const audioRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/audio/transcriptions",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["audio"],
        summary: "Ditado: transcreve o áudio enviado (multipart, campo `audio`)",
        consumes: ["multipart/form-data"],
        response: withErrors({ 200: z.object({ text: z.string() }) }),
      },
    },
    async (request) => {
      const part = await request.file({ limits: { fileSize: MAX_AUDIO_BYTES } })
      if (!part) throw new HttpError(400, "bad_request", "Envie o áudio no campo `audio`.")
      const buffer = await part.toBuffer()
      const { transcriptionModel: model } = await getSettings()
      const result = await openai().audio.transcriptions.create({
        model,
        file: await toFile(buffer, part.filename || "audio.webm", { type: part.mimetype }),
        language: "pt",
      })

      const usage = result.usage
      if (usage?.type === "tokens") {
        await recordUsage({
          source: "transcription",
          model,
          usage: {
            input: usage.input_tokens,
            cached: 0,
            output: usage.output_tokens,
            reasoning: 0,
          },
        })
      } else {
        const seconds = usage?.type === "duration" ? usage.seconds : buffer.length / 16_000
        const prices = await modelPrices(model)
        await recordUsage({
          source: "transcription",
          model,
          units: { seconds },
          costUsd: ((prices?.extraPrices.perMinute ?? 0) * seconds) / 60,
        })
      }
      return { text: result.text.trim() }
    },
  )

  app.post(
    "/audio/speech",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["audio"],
        summary: "Ler em voz alta: devolve áudio MP3",
        body: z.object({
          text: z.string().trim().min(1).max(4_096),
          voice: z.enum(voices).optional(),
        }),
        response: withErrors({ 200: z.string().describe("audio/mpeg") }),
      },
    },
    async (request, reply) => {
      const settings = await getSettings()
      const response = await openai().audio.speech.create({
        model: settings.speechModel,
        voice: request.body.voice ?? settings.speechVoice,
        input: request.body.text,
        instructions: "Fale em português do Brasil, de forma natural e clara.",
        response_format: "mp3",
      })
      const audio = Buffer.from(await response.arrayBuffer())

      const prices = await modelPrices(settings.speechModel)
      const chars = request.body.text.length
      const minutes = chars / CHARS_PER_MINUTE
      const costUsd = prices?.extraPrices.perMillionChars
        ? (prices.extraPrices.perMillionChars * chars) / 1_000_000
        : (prices?.extraPrices.perMinute ?? 0) * minutes
      await recordUsage({
        source: "speech",
        model: settings.speechModel,
        units: { chars, estimated: 1 },
        costUsd,
      })
      return reply
        .header("content-type", "audio/mpeg")
        .header("cache-control", "no-store")
        .send(audio)
    },
  )

  app.post(
    "/realtime/session",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["audio"],
        summary:
          "Modo voz: cria um token efêmero da Realtime API (10 min) para o WebRTC do navegador",
        body: z.object({ conversationId: z.uuid() }),
        response: withErrors({
          200: z.object({ clientSecret: z.string(), expiresAt: z.number(), model: z.string() }),
        }),
      },
    },
    async (request) => {
      const settings = await getSettings()
      const conversation = await getConversation(request.body.conversationId)
      const instructions =
        (await buildInstructions(conversation, settings)) +
        "\n\nVocê está numa conversa por voz: responda de forma curta e falada, sem markdown, listas ou código."
      const secret = await openai().realtime.clientSecrets.create({
        expires_after: { anchor: "created_at", seconds: 600 },
        session: {
          type: "realtime",
          model: settings.realtimeModel,
          instructions,
          audio: {
            input: { transcription: { model: settings.transcriptionModel, language: "pt" } },
            output: { voice: settings.realtimeVoice },
          },
        },
      })
      return {
        clientSecret: secret.value,
        expiresAt: secret.expires_at,
        model: settings.realtimeModel,
      }
    },
  )

  app.post(
    "/conversations/:id/voice-turns",
    {
      schema: {
        tags: ["audio"],
        summary: "Salvar a transcrição do modo voz como mensagens da conversa",
        params: z.object({ id: z.uuid() }),
        body: z.object({
          turns: z
            .array(
              z.object({
                role: z.enum(["user", "assistant"]),
                text: z.string().trim().min(1).max(20_000),
              }),
            )
            .min(1)
            .max(200),
          usage: z
            .object({
              textIn: z.number().int().min(0),
              textCached: z.number().int().min(0),
              textOut: z.number().int().min(0),
              audioIn: z.number().int().min(0),
              audioCached: z.number().int().min(0),
              audioOut: z.number().int().min(0),
            })
            .optional(),
        }),
        response: withErrors({ 200: z.object({ messages: z.array(messageSchema) }) }),
      },
    },
    async (request) => {
      const conversation = await getConversation(request.params.id)
      const settings = await getSettings()
      let parentId = conversation.currentLeafMessageId
      const saved = []
      for (const turn of request.body.turns) {
        const [row] = await db
          .insert(messages)
          .values({
            conversationId: conversation.id,
            parentId,
            role: turn.role,
            content: [{ type: "text", text: turn.text }],
            contentText: turn.text,
            model: turn.role === "assistant" ? settings.realtimeModel : null,
            params: { voice: true },
            completedAt: new Date(),
          })
          .returning()
        parentId = row!.id
        saved.push(row!)
      }
      await db
        .update(conversations)
        .set({ currentLeafMessageId: parentId, updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id))

      const usage = request.body.usage
      if (usage) {
        // Áudio tem preço próprio (extraPrices); texto usa o preço normal do modelo.
        const prices = await modelPrices(settings.realtimeModel)
        const extra = prices?.extraPrices ?? {}
        const textCost = await tokenCost(settings.realtimeModel, {
          input: usage.textIn,
          cached: usage.textCached,
          output: usage.textOut,
          reasoning: 0,
        })
        const audioCost =
          (Math.max(usage.audioIn - usage.audioCached, 0) * (extra.audioInput ?? 0) +
            usage.audioCached * (extra.audioCachedInput ?? 0) +
            usage.audioOut * (extra.audioOutput ?? 0)) /
          1_000_000
        await recordUsage({
          source: "realtime",
          model: settings.realtimeModel,
          usage: {
            input: usage.textIn + usage.audioIn,
            cached: usage.textCached + usage.audioCached,
            output: usage.textOut + usage.audioOut,
            reasoning: 0,
          },
          units: { audioIn: usage.audioIn, audioOut: usage.audioOut },
          costUsd: textCost + audioCost,
          messageId: parentId,
        })
      }
      // Conversa por voz entra na memória, na busca e ganha título como qualquer outra.
      await enqueue("messages.embed", { messageIds: saved.map((message) => message.id) })
      if (!conversation.title) {
        await enqueue(
          "conversation.title",
          { conversationId: conversation.id },
          { singleton: true, key: `title:${conversation.id}` },
        )
      }
      if (!conversation.anonymous) {
        await enqueue(
          "sinapses.consolidate",
          { conversationId: conversation.id },
          {
            delaySeconds: settings.sinapsesConsolidationDelaySeconds,
            key: `consolidate:${conversation.id}`,
          },
        )
      }
      return { messages: saved.map(toMessage) }
    },
  )
}
