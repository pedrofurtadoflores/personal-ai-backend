import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { conversations, folders, messages } from "../../db/schema.js"
import { HttpError, notFound, withErrors } from "../../lib/http.js"
import { isoDate, jsonDates } from "../../lib/serialize.js"
import { messagePart } from "../chat/parts.js"
import { getConversation, latestLeafBelow, listMessages } from "./service.js"

const id = z.uuid()

export const conversationSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  folderId: z.string().nullable(),
  model: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  settings: z.record(z.string(), z.unknown()),
  anonymous: z.boolean(),
  pinned: z.boolean(),
  archived: z.boolean(),
  currentLeafMessageId: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  deletedAt: isoDate.nullable(),
})

export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  parentId: z.string().nullable(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.array(messagePart),
  contentText: z.string().nullable(),
  model: z.string().nullable(),
  status: z.enum(["streaming", "completed", "stopped", "error"]),
  error: z.string().nullable(),
  tokensIn: z.number().nullable(),
  tokensCached: z.number().nullable(),
  tokensOut: z.number().nullable(),
  tokensReasoning: z.number().nullable(),
  costUsd: z.number().nullable(),
  createdAt: isoDate,
  completedAt: isoDate.nullable(),
})

const folderSchema = z.object({ id: z.string(), name: z.string(), position: z.number() })

const conversationSettings = z
  .object({
    reasoningEffort: z.string(),
    webSearch: z.boolean(),
    imageGeneration: z.boolean(),
  })
  .partial()

const createBody = z.object({
  title: z.string().max(200).optional(),
  model: z.string().optional(),
  systemPrompt: z.string().max(8_000).optional(),
  anonymous: z.boolean().optional(),
  folderId: id.nullable().optional(),
  settings: conversationSettings.optional(),
})

const patchBody = z
  .object({
    title: z.string().max(200).nullable(),
    model: z.string().nullable(),
    systemPrompt: z.string().max(8_000).nullable(),
    anonymous: z.boolean(),
    pinned: z.boolean(),
    archived: z.boolean(),
    folderId: id.nullable(),
    settings: conversationSettings,
  })
  .partial()

const toConversation = (row: typeof conversations.$inferSelect) =>
  conversationSchema.parse(jsonDates(row))
export const toMessage = (row: typeof messages.$inferSelect) => messageSchema.parse(jsonDates(row))

export const conversationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/conversations",
    {
      schema: {
        tags: ["conversations"],
        summary: "Listar conversas (sidebar, arquivadas ou lixeira)",
        querystring: z.object({
          view: z.enum(["active", "archived", "trash"]).default("active"),
          folderId: id.optional(),
        }),
        response: withErrors({ 200: z.object({ conversations: z.array(conversationSchema) }) }),
      },
    },
    async (request) => {
      const { view, folderId } = request.query
      const rows = await db
        .select()
        .from(conversations)
        .where(
          and(
            view === "trash" ? isNotNull(conversations.deletedAt) : isNull(conversations.deletedAt),
            view === "trash" ? undefined : eq(conversations.archived, view === "archived"),
            folderId ? eq(conversations.folderId, folderId) : undefined,
          ),
        )
        .orderBy(desc(conversations.pinned), desc(conversations.updatedAt))
        .limit(500)
      return { conversations: rows.map(toConversation) }
    },
  )

  app.post(
    "/conversations",
    {
      schema: {
        tags: ["conversations"],
        summary: "Criar conversa",
        body: createBody,
        response: withErrors({ 201: conversationSchema }),
      },
    },
    async (request, reply) => {
      const [row] = await db
        .insert(conversations)
        .values({ ...request.body, settings: request.body.settings ?? {} })
        .returning()
      return reply.code(201).send(toConversation(row!))
    },
  )

  app.get(
    "/conversations/:id",
    {
      schema: {
        tags: ["conversations"],
        summary: "Conversa com todas as mensagens (todos os ramos)",
        params: z.object({ id }),
        response: withErrors({
          200: z.object({ conversation: conversationSchema, messages: z.array(messageSchema) }),
        }),
      },
    },
    async (request) => {
      const conversation = await getConversation(request.params.id, { includeDeleted: true })
      const all = await listMessages(conversation.id)
      return { conversation: toConversation(conversation), messages: all.map(toMessage) }
    },
  )

  app.patch(
    "/conversations/:id",
    {
      schema: {
        tags: ["conversations"],
        summary: "Renomear, fixar, arquivar, mover ou configurar",
        params: z.object({ id }),
        body: patchBody,
        response: withErrors({ 200: conversationSchema }),
      },
    },
    async (request) => {
      const current = await getConversation(request.params.id)
      const { settings, ...rest } = request.body
      const [row] = await db
        .update(conversations)
        .set({
          ...rest,
          ...(settings ? { settings: { ...current.settings, ...settings } } : {}),
          updatedAt: current.updatedAt, // mexer em metadados não reordena a sidebar
        })
        .where(eq(conversations.id, current.id))
        .returning()
      return toConversation(row!)
    },
  )

  app.put(
    "/conversations/:id/leaf",
    {
      schema: {
        tags: ["conversations"],
        summary: "Trocar o ramo exibido (navegar entre versões de uma mensagem)",
        params: z.object({ id }),
        body: z.object({ messageId: id }),
        response: withErrors({ 200: z.object({ currentLeafMessageId: z.string() }) }),
      },
    },
    async (request) => {
      const conversation = await getConversation(request.params.id)
      const all = await listMessages(conversation.id)
      if (!all.some((message) => message.id === request.body.messageId)) throw notFound("Mensagem")
      const leaf = latestLeafBelow(all, request.body.messageId)
      await db
        .update(conversations)
        .set({ currentLeafMessageId: leaf, updatedAt: conversation.updatedAt })
        .where(eq(conversations.id, conversation.id))
      return { currentLeafMessageId: leaf }
    },
  )

  app.delete(
    "/conversations/:id",
    {
      schema: {
        tags: ["conversations"],
        summary: "Mandar para a lixeira (soft delete, D27)",
        params: z.object({ id }),
        response: withErrors({ 204: z.null() }),
      },
    },
    async (request, reply) => {
      const conversation = await getConversation(request.params.id)
      await db
        .update(conversations)
        .set({ deletedAt: new Date() })
        .where(eq(conversations.id, conversation.id))
      return reply.code(204).send(null)
    },
  )

  app.post(
    "/conversations/:id/restore",
    {
      schema: {
        tags: ["conversations"],
        summary: "Restaurar da lixeira",
        params: z.object({ id }),
        response: withErrors({ 200: conversationSchema }),
      },
    },
    async (request) => {
      const [row] = await db
        .update(conversations)
        .set({ deletedAt: null })
        .where(eq(conversations.id, request.params.id))
        .returning()
      if (!row) throw notFound("Conversa")
      return toConversation(row)
    },
  )

  app.delete(
    "/conversations/:id/permanent",
    {
      schema: {
        tags: ["conversations"],
        summary: "Apagar de vez (só a partir da lixeira)",
        params: z.object({ id }),
        response: withErrors({ 204: z.null() }),
      },
    },
    async (request, reply) => {
      const conversation = await getConversation(request.params.id, { includeDeleted: true })
      if (!conversation.deletedAt) {
        throw new HttpError(409, "not_in_trash", "Mande a conversa para a lixeira antes.")
      }
      await db.delete(conversations).where(eq(conversations.id, conversation.id))
      return reply.code(204).send(null)
    },
  )

  // ─── Pastas ─────────────────────────────────────────────────────────────────

  app.get(
    "/folders",
    {
      schema: {
        tags: ["folders"],
        summary: "Listar pastas",
        response: withErrors({ 200: z.object({ folders: z.array(folderSchema) }) }),
      },
    },
    async () => ({
      folders: await db
        .select({ id: folders.id, name: folders.name, position: folders.position })
        .from(folders)
        .orderBy(asc(folders.position), asc(folders.name)),
    }),
  )

  app.post(
    "/folders",
    {
      schema: {
        tags: ["folders"],
        summary: "Criar pasta",
        body: z.object({ name: z.string().trim().min(1).max(80) }),
        response: withErrors({ 201: folderSchema }),
      },
    },
    async (request, reply) => {
      const [{ next } = { next: 0 }] = await db
        .select({ next: sql<number>`coalesce(max(${folders.position}), -1)::int + 1` })
        .from(folders)
      const [row] = await db
        .insert(folders)
        .values({ name: request.body.name, position: next })
        .returning({ id: folders.id, name: folders.name, position: folders.position })
      return reply.code(201).send(row!)
    },
  )

  app.patch(
    "/folders/:id",
    {
      schema: {
        tags: ["folders"],
        summary: "Renomear ou reordenar pasta",
        params: z.object({ id }),
        body: z
          .object({ name: z.string().trim().min(1).max(80), position: z.number().int() })
          .partial(),
        response: withErrors({ 200: folderSchema }),
      },
    },
    async (request) => {
      const [row] = await db
        .update(folders)
        .set(request.body)
        .where(eq(folders.id, request.params.id))
        .returning({ id: folders.id, name: folders.name, position: folders.position })
      if (!row) throw notFound("Pasta")
      return row
    },
  )

  app.delete(
    "/folders/:id",
    {
      schema: {
        tags: ["folders"],
        summary: "Apagar pasta (as conversas saem da pasta, não são apagadas)",
        params: z.object({ id }),
        response: withErrors({ 204: z.null() }),
      },
    },
    async (request, reply) => {
      await db.delete(folders).where(eq(folders.id, request.params.id))
      return reply.code(204).send(null)
    },
  )
}
