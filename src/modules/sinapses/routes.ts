import { and, desc, eq, isNull, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { conversations, sinapseSources, sinapseSuggestions, sinapses } from "../../db/schema.js"
import { withErrors } from "../../lib/http.js"
import { isoDate, jsonDates } from "../../lib/serialize.js"
import {
  createSinapse,
  getSinapse,
  graph,
  linkSinapses,
  linksOf,
  listVersions,
  mergeSinapses,
  resolveSuggestion,
  restoreVersion,
  searchSinapses,
  softDeleteSinapse,
  splitSinapse,
  undoVersion,
  unlinkSinapses,
  updateSinapse,
  type Sinapse,
} from "./service.js"

const id = z.uuid()

export const sinapseSchema = z.object({
  id: z.string(),
  title: z.string(),
  emoji: z.string().nullable(),
  summary: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  status: z.enum(["active", "archived"]),
  locked: z.boolean(),
  pinned: z.boolean(),
  createdBy: z.enum(["ai", "user"]),
  createdAt: isoDate,
  updatedAt: isoDate,
})

const sinapseSummary = sinapseSchema.omit({ content: true })

const versionSchema = z.object({
  id: z.string(),
  title: z.string(),
  emoji: z.string().nullable(),
  summary: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  author: z.enum(["ai", "user"]),
  reason: z.string().nullable(),
  sourceMessageId: z.string().nullable(),
  createdAt: isoDate,
})

const suggestionSchema = z.object({
  id: z.string(),
  sinapseId: z.string().nullable(),
  sinapseTitle: z.string().nullable(),
  kind: z.enum(["create", "update", "merge", "link"]),
  payload: z.unknown(),
  reason: z.string().nullable(),
  createdAt: isoDate,
})

const inputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  emoji: z.string().max(16).nullable().optional(),
  summary: z.string().max(1_000).default(""),
  content: z.string().max(200_000).default(""),
  tags: z.array(z.string().max(40)).max(12).default([]),
})

const toSinapse = (row: Sinapse) => sinapseSchema.parse(jsonDates(row))
const toSummary = (
  row: Omit<z.input<typeof sinapseSummary>, "createdAt" | "updatedAt"> & {
    createdAt: Date
    updatedAt: Date
  },
) => sinapseSummary.parse(jsonDates(row))

const linkSchema = z.object({
  id: z.string(),
  title: z.string(),
  emoji: z.string().nullable(),
  reason: z.string().nullable(),
  createdBy: z.enum(["ai", "user"]),
})

const sourceSchema = z.object({
  conversationId: z.string().nullable(),
  conversationTitle: z.string().nullable(),
  messageId: z.string().nullable(),
  fileId: z.string().nullable(),
  createdAt: isoDate,
})

export const sinapseRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/sinapses",
    {
      schema: {
        tags: ["sinapses"],
        summary: "Listar sinapses (filtros por estado, tag e busca)",
        querystring: z.object({
          status: z.enum(["active", "archived"]).default("active"),
          tag: z.string().optional(),
          q: z.string().optional(),
        }),
        response: withErrors({
          200: z.object({
            sinapses: z.array(sinapseSummary),
            tags: z.array(z.object({ tag: z.string(), count: z.number() })),
            pendingSuggestions: z.number(),
          }),
        }),
      },
    },
    async (request) => {
      const { status, tag, q } = request.query
      const where = and(
        isNull(sinapses.deletedAt),
        eq(sinapses.status, status),
        tag ? sql`${tag} = any(${sinapses.tags})` : undefined,
      )
      const columns = {
        id: sinapses.id,
        title: sinapses.title,
        emoji: sinapses.emoji,
        summary: sinapses.summary,
        tags: sinapses.tags,
        status: sinapses.status,
        locked: sinapses.locked,
        pinned: sinapses.pinned,
        createdBy: sinapses.createdBy,
        createdAt: sinapses.createdAt,
        updatedAt: sinapses.updatedAt,
      }

      // Sem os vetores de embedding: são grandes e não servem para a tela.
      let rows: Awaited<ReturnType<ReturnType<typeof db.select<typeof columns>>["from"]>>
      if (q?.trim()) {
        const hits = await searchSinapses(q, 40)
        const order = new Map(hits.map((hit, index) => [hit.id, index]))
        const all = await db.select(columns).from(sinapses).where(where)
        rows = all
          .filter((row) => order.has(row.id))
          .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
      } else {
        rows = await db
          .select(columns)
          .from(sinapses)
          .where(where)
          .orderBy(desc(sinapses.pinned), desc(sinapses.updatedAt))
      }

      const tags = await db.execute<{ tag: string; count: number }>(
        sql`select tag, count(*)::int as count from ${sinapses}, unnest(${sinapses.tags}) as tag
            where ${sinapses.deletedAt} is null and ${sinapses.status} = 'active'
            group by tag order by count desc, tag limit 60`,
      )
      const [{ pending } = { pending: 0 }] = await db
        .select({ pending: sql<number>`count(*)::int` })
        .from(sinapseSuggestions)
        .where(eq(sinapseSuggestions.status, "pending"))
      return { sinapses: rows.map(toSummary), tags: tags.rows, pendingSuggestions: pending }
    },
  )

  app.get(
    "/sinapses/graph",
    {
      schema: {
        tags: ["sinapses"],
        summary: "Grafo de conexões",
        response: withErrors({
          200: z.object({
            nodes: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                emoji: z.string().nullable(),
                pinned: z.boolean(),
                tags: z.array(z.string()),
                size: z.number(),
              }),
            ),
            edges: z.array(
              z.object({ source: z.string(), target: z.string(), reason: z.string().nullable() }),
            ),
          }),
        }),
      },
    },
    async () => graph(),
  )

  app.get(
    "/sinapses/suggestions",
    {
      schema: {
        tags: ["sinapses"],
        summary: "Sugestões pendentes (sinapses travadas, conteúdo externo, mesclas)",
        response: withErrors({ 200: z.object({ suggestions: z.array(suggestionSchema) }) }),
      },
    },
    async () => {
      const rows = await db
        .select({
          id: sinapseSuggestions.id,
          sinapseId: sinapseSuggestions.sinapseId,
          sinapseTitle: sinapses.title,
          kind: sinapseSuggestions.kind,
          payload: sinapseSuggestions.payload,
          reason: sinapseSuggestions.reason,
          createdAt: sinapseSuggestions.createdAt,
        })
        .from(sinapseSuggestions)
        .leftJoin(sinapses, eq(sinapses.id, sinapseSuggestions.sinapseId))
        .where(eq(sinapseSuggestions.status, "pending"))
        .orderBy(desc(sinapseSuggestions.createdAt))
      return { suggestions: rows.map((row) => suggestionSchema.parse(jsonDates(row))) }
    },
  )

  app.post(
    "/sinapses/suggestions/:id/:decision",
    {
      schema: {
        tags: ["sinapses"],
        summary: "Aceitar ou rejeitar uma sugestão",
        params: z.object({ id, decision: z.enum(["accept", "reject"]) }),
        response: withErrors({ 200: z.object({ sinapseId: z.string().nullable() }) }),
      },
    },
    async (request) => resolveSuggestion(request.params.id, request.params.decision === "accept"),
  )

  app.post(
    "/sinapses",
    {
      schema: {
        tags: ["sinapses"],
        summary: "Criar sinapse manualmente",
        body: inputSchema,
        response: withErrors({ 201: sinapseSchema }),
      },
    },
    async (request, reply) => {
      const { sinapse } = await createSinapse(request.body, {
        author: "user",
        reason: "Criada manualmente",
      })
      return reply.code(201).send(toSinapse(sinapse))
    },
  )

  app.get(
    "/sinapses/:id",
    {
      schema: {
        tags: ["sinapses"],
        summary: "Sinapse com conexões e origens",
        params: z.object({ id }),
        response: withErrors({
          200: z.object({
            sinapse: sinapseSchema,
            links: z.array(linkSchema),
            sources: z.array(sourceSchema),
          }),
        }),
      },
    },
    async (request) => {
      const sinapse = await getSinapse(request.params.id)
      const [links, sources] = await Promise.all([
        linksOf(sinapse.id),
        db
          .select({
            conversationId: sinapseSources.conversationId,
            conversationTitle: conversations.title,
            messageId: sinapseSources.messageId,
            fileId: sinapseSources.fileId,
            createdAt: sinapseSources.createdAt,
          })
          .from(sinapseSources)
          .leftJoin(conversations, eq(conversations.id, sinapseSources.conversationId))
          .where(eq(sinapseSources.sinapseId, sinapse.id))
          .orderBy(desc(sinapseSources.createdAt))
          .limit(50),
      ])
      return {
        sinapse: toSinapse(sinapse),
        links,
        sources: sources.map((source) => sourceSchema.parse(jsonDates(source))),
      }
    },
  )

  app.patch(
    "/sinapses/:id",
    {
      schema: {
        tags: ["sinapses"],
        summary: "Editar, travar, fixar ou arquivar",
        params: z.object({ id }),
        body: inputSchema
          .partial()
          .extend({
            locked: z.boolean(),
            pinned: z.boolean(),
            status: z.enum(["active", "archived"]),
          })
          .partial(),
        response: withErrors({ 200: sinapseSchema }),
      },
    },
    async (request) => {
      const { sinapse } = await updateSinapse(request.params.id, request.body, {
        author: "user",
        reason: "Edição manual",
      })
      return toSinapse(sinapse)
    },
  )

  app.delete(
    "/sinapses/:id",
    {
      schema: {
        tags: ["sinapses"],
        summary: "Apagar (vai para a lixeira)",
        params: z.object({ id }),
        response: withErrors({ 204: z.null() }),
      },
    },
    async (request, reply) => {
      await softDeleteSinapse(request.params.id)
      return reply.code(204).send(null)
    },
  )

  app.get(
    "/sinapses/:id/versions",
    {
      schema: {
        tags: ["sinapses"],
        summary: "Histórico de versões",
        params: z.object({ id }),
        response: withErrors({ 200: z.object({ versions: z.array(versionSchema) }) }),
      },
    },
    async (request) => {
      await getSinapse(request.params.id)
      const versions = await listVersions(request.params.id)
      return { versions: versions.map((version) => versionSchema.parse(jsonDates(version))) }
    },
  )

  app.post(
    "/sinapses/:id/versions/:versionId/restore",
    {
      schema: {
        tags: ["sinapses"],
        summary: "Restaurar uma versão (gera uma versão nova)",
        params: z.object({ id, versionId: id }),
        response: withErrors({ 200: sinapseSchema }),
      },
    },
    async (request) =>
      toSinapse((await restoreVersion(request.params.id, request.params.versionId)).sinapse),
  )

  app.post(
    "/sinapses/versions/:versionId/undo",
    {
      schema: {
        tags: ["sinapses"],
        summary: "Desfazer a mudança que gerou a versão (chip do chat)",
        params: z.object({ versionId: id }),
        response: withErrors({ 200: z.object({ deleted: z.boolean(), sinapseId: z.string() }) }),
      },
    },
    async (request) => undoVersion(request.params.versionId),
  )

  app.post(
    "/sinapses/links",
    {
      schema: {
        tags: ["sinapses"],
        summary: "Conectar duas sinapses",
        body: z.object({ a: id, b: id, reason: z.string().max(300).nullable().default(null) }),
        response: withErrors({ 200: z.object({ sinapseA: z.string(), sinapseB: z.string() }) }),
      },
    },
    async (request) => linkSinapses(request.body.a, request.body.b, request.body.reason, "user"),
  )

  app.delete(
    "/sinapses/links/:a/:b",
    {
      schema: {
        tags: ["sinapses"],
        summary: "Desconectar duas sinapses",
        params: z.object({ a: id, b: id }),
        response: withErrors({ 204: z.null() }),
      },
    },
    async (request, reply) => {
      await unlinkSinapses(request.params.a, request.params.b)
      return reply.code(204).send(null)
    },
  )

  app.post(
    "/sinapses/:id/merge",
    {
      schema: {
        tags: ["sinapses"],
        summary: "Mesclar outras sinapses nesta (as outras são arquivadas)",
        params: z.object({ id }),
        body: z.object({ sourceIds: z.array(id).min(1).max(10) }),
        response: withErrors({ 200: sinapseSchema }),
      },
    },
    async (request) =>
      toSinapse(
        (await mergeSinapses(request.params.id, request.body.sourceIds, { author: "user" }))
          .sinapse,
      ),
  )

  app.post(
    "/sinapses/:id/split",
    {
      schema: {
        tags: ["sinapses"],
        summary: "Dividir: mover parte do conteúdo para uma sinapse nova",
        params: z.object({ id }),
        body: z.object({ remainingContent: z.string(), extracted: inputSchema }),
        response: withErrors({ 201: sinapseSchema }),
      },
    },
    async (request, reply) => {
      const { sinapse } = await splitSinapse(
        request.params.id,
        request.body.remainingContent,
        request.body.extracted,
      )
      return reply.code(201).send(toSinapse(sinapse))
    },
  )
}
