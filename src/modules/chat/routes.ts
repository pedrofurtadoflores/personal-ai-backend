import { and, eq, inArray, isNull } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { conversations, files, messages } from "../../db/schema.js"
import { HttpError, notFound, withErrors } from "../../lib/http.js"
import { openSse } from "../../lib/sse.js"
import { toMessage } from "../conversations/routes.js"
import { getConversation, type Message } from "../conversations/service.js"
import { generateReply, type ReplyOptions } from "./orchestrator.js"
import type { MessagePart } from "./parts.js"

const replyOptions = z.object({
  model: z.string().min(1).optional(),
  reasoningEffort: z.string().optional(),
  webSearch: z.boolean().optional(),
  imageGeneration: z.boolean().optional(),
})

const sendBody = replyOptions.extend({
  /** Mensagem à qual esta responde. `null` = começo da conversa (ou editar a primeira mensagem). */
  parentId: z.uuid().nullable(),
  text: z.string().max(200_000).default(""),
  fileIds: z.array(z.uuid()).max(20).default([]),
})

const sseDescription =
  "Resposta em Server-Sent Events: `start` {userMessage?, assistantMessage}, `delta` {text}, " +
  "`part` (chip de sinapse, contexto, busca), `image` {fileId, url}, `status` {tool, state}, " +
  "`error` {error, message} e `done` {message}."

/** Abre o SSE, cria a mensagem do assistente e gera a resposta. */
async function streamReply(params: {
  reply: Parameters<typeof openSse>[0]
  conversation: Awaited<ReturnType<typeof getConversation>>
  userMessage: Message
  options: ReplyOptions
  sendUser: boolean
}) {
  const { conversation, userMessage } = params
  const [assistant] = await db
    .insert(messages)
    .values({
      conversationId: conversation.id,
      parentId: userMessage.id,
      role: "assistant",
      status: "streaming",
      model: params.options.model ?? conversation.model,
    })
    .returning()
  await db
    .update(conversations)
    .set({ currentLeafMessageId: assistant!.id, updatedAt: new Date() })
    .where(eq(conversations.id, conversation.id))

  const sse = openSse(params.reply)
  const controller = new AbortController()
  // Usuário clicou em "parar" (fetch abortado) → para a geração e salva o parcial.
  params.reply.raw.on("close", () => {
    if (!params.reply.raw.writableEnded) controller.abort()
  })

  sse.send("start", {
    ...(params.sendUser ? { userMessage: toMessage(userMessage) } : {}),
    assistantMessage: toMessage(assistant!),
  })

  const saved = await generateReply({
    conversation,
    userMessage,
    assistantMessageId: assistant!.id,
    options: params.options,
    emit: sse.send,
    signal: controller.signal,
  })
  sse.send("done", { message: toMessage(saved) })
  sse.end()
}

export const chatRoutes: FastifyPluginAsyncZod = async (app) => {
  const rateLimit = { max: 30, timeWindow: "1 minute" }

  app.post(
    "/conversations/:id/messages",
    {
      config: { rateLimit },
      schema: {
        tags: ["chat"],
        summary: "Enviar mensagem e receber a resposta em streaming",
        description: sseDescription,
        params: z.object({ id: z.uuid() }),
        body: sendBody,
        response: withErrors({ 200: z.string().describe("text/event-stream") }),
      },
    },
    async (request, reply) => {
      const conversation = await getConversation(request.params.id)
      const { parentId, text, fileIds, ...options } = request.body
      if (!text.trim() && !fileIds.length) {
        throw new HttpError(400, "empty_message", "Escreva uma mensagem ou anexe um arquivo.")
      }
      if (parentId) {
        const [parent] = await db
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.id, parentId), eq(messages.conversationId, conversation.id)))
        if (!parent) throw notFound("Mensagem")
      }

      const attached = fileIds.length
        ? await db
            .select()
            .from(files)
            .where(and(inArray(files.id, fileIds), isNull(files.deletedAt)))
        : []
      if (attached.length !== fileIds.length) throw notFound("Arquivo")
      // Arquivos soltos passam a pertencer a esta conversa (entram no RAG dela).
      if (attached.length) {
        await db
          .update(files)
          .set({ conversationId: conversation.id })
          .where(and(inArray(files.id, fileIds), isNull(files.conversationId)))
      }

      const content: MessagePart[] = [
        ...attached.map((file) => ({
          type: "file" as const,
          fileId: file.id,
          name: file.name,
          mime: file.mime,
        })),
        ...(text.trim() ? [{ type: "text" as const, text }] : []),
      ]
      const [userMessage] = await db
        .insert(messages)
        .values({
          conversationId: conversation.id,
          parentId,
          role: "user",
          content,
          contentText: text.trim() || null,
          completedAt: new Date(),
        })
        .returning()

      await streamReply({ reply, conversation, userMessage: userMessage!, options, sendUser: true })
      return reply
    },
  )

  app.post(
    "/conversations/:id/messages/:messageId/regenerate",
    {
      config: { rateLimit },
      schema: {
        tags: ["chat"],
        summary: "Gerar outra versão da resposta (fica como irmã da anterior)",
        description: sseDescription,
        params: z.object({ id: z.uuid(), messageId: z.uuid() }),
        body: replyOptions.default({}),
        response: withErrors({ 200: z.string().describe("text/event-stream") }),
      },
    },
    async (request, reply) => {
      const conversation = await getConversation(request.params.id)
      const [target] = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.id, request.params.messageId),
            eq(messages.conversationId, conversation.id),
          ),
        )
      if (!target) throw notFound("Mensagem")

      // Regenerar uma resposta = nova resposta para a mesma pergunta.
      let userMessage = target
      if (target.role === "assistant") {
        const [parent] = target.parentId
          ? await db.select().from(messages).where(eq(messages.id, target.parentId))
          : []
        if (!parent)
          throw new HttpError(409, "no_parent", "Esta resposta não tem pergunta associada.")
        userMessage = parent
      }
      if (userMessage.role !== "user") throw new HttpError(400, "bad_request", "Mensagem inválida.")

      await streamReply({
        reply,
        conversation,
        userMessage,
        options: request.body,
        sendUser: false,
      })
      return reply
    },
  )
}
