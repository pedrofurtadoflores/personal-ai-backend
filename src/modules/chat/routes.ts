import { and, eq, inArray, isNull } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { conversations, files, messages, sinapses } from "../../db/schema.js"
import { HttpError, notFound, withErrors } from "../../lib/http.js"
import { enqueue } from "../../lib/jobs.js"
import { messageSchema, toMessage } from "../conversations/routes.js"
import { getConversation, type Conversation, type Message } from "../conversations/service.js"
import "./feedback.js"
import { generateReply, type ReplyOptions } from "./orchestrator.js"
import type { MessagePart } from "./parts.js"
import { activeRun, createRun, pipeRun, stopRun, type Run } from "./runs.js"
import { homeSuggestions } from "./suggestions.js"

const replyOptions = z.object({
  model: z.string().min(1).optional(),
  reasoningEffort: z.string().optional(),
  webSearch: z.boolean().optional(),
  imageGeneration: z.boolean().optional(),
  codeInterpreter: z.boolean().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
})

const sendBody = replyOptions.extend({
  /** Mensagem à qual esta responde. `null` = começo da conversa (ou editar a primeira mensagem). */
  parentId: z.uuid().nullable(),
  text: z.string().max(200_000).default(""),
  fileIds: z.array(z.uuid()).max(20).default([]),
  /** Sinapses mencionadas com @: entram inteiras no contexto (D76). */
  sinapseIds: z.array(z.uuid()).max(10).default([]),
})

const sseDescription =
  "Resposta em Server-Sent Events: `start` {userMessage?, assistantMessage}, `delta` {text}, " +
  "`part` (chip de sinapse, contexto, busca), `image` {fileId, url}, `status` {tool, state}, " +
  "`error` {error, message} e `done` {message}. A geração não depende da conexão (D68): " +
  "se ela cair, `GET /conversations/:id/stream` retoma desde o começo."

/** Cria a mensagem do assistente e começa a gerar em segundo plano (D68). */
async function startReply(params: {
  run: Run
  conversation: Conversation
  userMessage: Message
  options: ReplyOptions
  sendUser: boolean
  continueFrom?: Message
}) {
  const { run, conversation, userMessage } = params
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

  run.start(async (emit, signal) => {
    emit("start", {
      ...(params.sendUser ? { userMessage: toMessage(userMessage) } : {}),
      assistantMessage: toMessage(assistant!),
    })
    const saved = await generateReply({
      conversation,
      userMessage,
      assistantMessageId: assistant!.id,
      options: params.options,
      continueFrom: params.continueFrom,
      emit,
      signal,
    })
    emit("done", { message: toMessage(saved) })
  })
}

/** Pega a trava da conversa (D66), prepara e começa; libera a trava se algo falhar antes. */
async function withRun(conversationId: string, prepare: (run: Run) => Promise<void>) {
  const run = createRun(conversationId)
  try {
    await prepare(run)
  } catch (error) {
    run.discard()
    throw error
  }
  return run
}

async function messageIn(conversationId: string, messageId: string) {
  const [row] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.conversationId, conversationId),
        isNull(messages.deletedAt),
      ),
    )
  if (!row) throw notFound("Mensagem")
  return row
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
      const { parentId, text, fileIds, sinapseIds, ...options } = request.body
      if (!text.trim() && !fileIds.length) {
        throw new HttpError(400, "empty_message", "Escreva uma mensagem ou anexe um arquivo.")
      }
      if (sinapseIds.length && conversation.anonymous) {
        throw new HttpError(400, "anonymous_memory", "Conversa anônima não usa a memória.")
      }
      if (parentId) await messageIn(conversation.id, parentId)

      const run = await withRun(conversation.id, async (run) => {
        const attached = fileIds.length
          ? await db
              .select()
              .from(files)
              .where(and(inArray(files.id, fileIds), isNull(files.deletedAt)))
          : []
        if (attached.length !== new Set(fileIds).size) throw notFound("Arquivo")
        const mentioned = sinapseIds.length
          ? await db
              .select({ id: sinapses.id, title: sinapses.title })
              .from(sinapses)
              .where(and(inArray(sinapses.id, sinapseIds), isNull(sinapses.deletedAt)))
          : []
        if (mentioned.length !== new Set(sinapseIds).size) throw notFound("Sinapse")
        // Arquivos soltos passam a pertencer a esta conversa (entram no RAG dela).
        if (attached.length) {
          await db
            .update(files)
            .set({ conversationId: conversation.id })
            .where(
              and(inArray(files.id, fileIds), isNull(files.conversationId), isNull(files.folderId)),
            )
        }

        const content: MessagePart[] = [
          ...attached.map((file) => ({
            type: "file" as const,
            fileId: file.id,
            name: file.name,
            mime: file.mime,
          })),
          ...mentioned.map((sinapse) => ({
            type: "mention" as const,
            sinapseId: sinapse.id,
            title: sinapse.title,
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

        await startReply({ run, conversation, userMessage: userMessage!, options, sendUser: true })
      })
      await pipeRun(reply, run)
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
      const target = await messageIn(conversation.id, request.params.messageId)

      // Regenerar uma resposta = nova resposta para a mesma pergunta.
      let userMessage = target
      if (target.role === "assistant") {
        if (!target.parentId) {
          throw new HttpError(409, "no_parent", "Esta resposta não tem pergunta associada.")
        }
        userMessage = await messageIn(conversation.id, target.parentId)
      }
      if (userMessage.role !== "user") throw new HttpError(400, "bad_request", "Mensagem inválida.")

      const run = await withRun(conversation.id, (run) =>
        startReply({ run, conversation, userMessage, options: request.body, sendUser: false }),
      )
      await pipeRun(reply, run)
      return reply
    },
  )

  app.post(
    "/conversations/:id/messages/:messageId/continue",
    {
      config: { rateLimit },
      schema: {
        tags: ["chat"],
        summary: "Continuar uma resposta cortada ou interrompida (vira uma nova versão, D69)",
        description: sseDescription,
        params: z.object({ id: z.uuid(), messageId: z.uuid() }),
        body: replyOptions.default({}),
        response: withErrors({ 200: z.string().describe("text/event-stream") }),
      },
    },
    async (request, reply) => {
      const conversation = await getConversation(request.params.id)
      const target = await messageIn(conversation.id, request.params.messageId)
      if (target.role !== "assistant" || !["incomplete", "stopped"].includes(target.status)) {
        throw new HttpError(
          409,
          "not_continuable",
          "Só dá para continuar uma resposta cortada ou interrompida.",
        )
      }
      if (!target.contentText?.trim()) {
        throw new HttpError(409, "not_continuable", "A resposta está vazia: use regenerar.")
      }
      if (!target.parentId) {
        throw new HttpError(409, "no_parent", "Esta resposta não tem pergunta associada.")
      }
      const userMessage = await messageIn(conversation.id, target.parentId)
      const run = await withRun(conversation.id, (run) =>
        startReply({
          run,
          conversation,
          userMessage,
          // Mesmo modelo da resposta cortada, a menos que o pedido diga outro.
          options: { model: target.model, ...request.body },
          sendUser: false,
          continueFrom: target,
        }),
      )
      await pipeRun(reply, run)
      return reply
    },
  )

  app.get(
    "/conversations/:id/stream",
    {
      schema: {
        tags: ["chat"],
        summary: "Retomar a resposta em andamento (D68): reenvia tudo desde o começo",
        description: `${sseDescription} Sem resposta em andamento: 204.`,
        params: z.object({ id: z.uuid() }),
        response: withErrors({
          200: z.string().describe("text/event-stream"),
          204: z.null(),
        }),
      },
    },
    async (request, reply) => {
      const conversation = await getConversation(request.params.id)
      const run = activeRun(conversation.id)
      if (!run) return reply.code(204).send(null)
      await pipeRun(reply, run)
      return reply
    },
  )

  app.post(
    "/conversations/:id/stop",
    {
      schema: {
        tags: ["chat"],
        summary: "Parar a resposta em andamento (o parcial fica salvo como `stopped`)",
        params: z.object({ id: z.uuid() }),
        response: withErrors({ 200: z.object({ stopped: z.boolean() }) }),
      },
    },
    async (request) => {
      const conversation = await getConversation(request.params.id)
      const run = activeRun(conversation.id)
      const stopped = stopRun(conversation.id)
      // Responde depois de salvar o parcial: o front recarrega e já vê o estado final.
      await run?.done
      return { stopped }
    },
  )

  app.put(
    "/conversations/:id/messages/:messageId/feedback",
    {
      schema: {
        tags: ["chat"],
        summary: "Avaliar uma resposta (👍/👎); com comentário, a IA aprende a preferência (D77)",
        params: z.object({ id: z.uuid(), messageId: z.uuid() }),
        body: z.object({
          rating: z.enum(["up", "down"]).nullable(),
          note: z.string().trim().max(2_000).nullable().optional(),
        }),
        response: withErrors({ 200: messageSchema }),
      },
    },
    async (request) => {
      const conversation = await getConversation(request.params.id)
      const target = await messageIn(conversation.id, request.params.messageId)
      if (target.role !== "assistant") {
        throw new HttpError(400, "bad_request", "Só respostas do assistente podem ser avaliadas.")
      }
      const { rating, note } = request.body
      const [row] = await db
        .update(messages)
        .set({ rating, feedbackNote: rating ? note || null : null })
        .where(eq(messages.id, target.id))
        .returning()
      if (rating && note && !conversation.anonymous) {
        // Espera um pouco: trocar a avaliação logo em seguida não gera duas escritas.
        await enqueue(
          "feedback.learn",
          { messageId: target.id },
          { delaySeconds: 20, key: `feedback:${target.id}` },
        )
      }
      return toMessage(row!)
    },
  )

  app.get(
    "/chat/suggestions",
    {
      config: { rateLimit },
      schema: {
        tags: ["chat"],
        summary: "Sugestões da tela inicial, a partir da memória e das conversas recentes (D72)",
        response: withErrors({
          200: z.object({ suggestions: z.array(z.string()), personalized: z.boolean() }),
        }),
      },
    },
    async () => homeSuggestions(),
  )
}
