import { and, cosineDistance, desc, eq, ilike, isNull, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { conversations, messageEmbeddings, messages } from "../../db/schema.js"
import { embedOne } from "../../lib/embeddings.js"
import { withErrors } from "../../lib/http.js"
import { searchSinapses } from "../sinapses/service.js"

const hitSchema = z.object({
  conversationId: z.string(),
  title: z.string().nullable(),
  messageId: z.string().nullable(),
  snippet: z.string(),
  score: z.number(),
})

export const searchRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/search",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["search"],
        summary: "Busca no histórico (texto + semântica) e nas sinapses",
        querystring: z.object({
          q: z.string().trim().min(2).max(300),
          semantic: z.stringbool().default(true),
        }),
        response: withErrors({
          200: z.object({
            conversations: z.array(hitSchema),
            sinapses: z.array(z.object({ id: z.string(), title: z.string(), snippet: z.string() })),
          }),
        }),
      },
    },
    async (request) => {
      const { q, semantic } = request.query
      const tsQuery = sql`websearch_to_tsquery('portuguese', ${q})`
      const alive = and(isNull(messages.deletedAt), isNull(conversations.deletedAt))

      const [textHits, titleHits] = await Promise.all([
        db
          .select({
            conversationId: conversations.id,
            title: conversations.title,
            messageId: messages.id,
            snippet: sql<string>`ts_headline('portuguese', coalesce(${messages.contentText}, ''), ${tsQuery}, 'MaxWords=30, MinWords=10, StartSel=«, StopSel=»')`,
            score: sql<number>`ts_rank(${messages.searchVector}, ${tsQuery})`,
          })
          .from(messages)
          .innerJoin(conversations, eq(conversations.id, messages.conversationId))
          .where(and(alive, sql`${messages.searchVector} @@ ${tsQuery}`))
          .orderBy(desc(sql`ts_rank(${messages.searchVector}, ${tsQuery})`))
          .limit(30),
        db
          .select({ conversationId: conversations.id, title: conversations.title })
          .from(conversations)
          .where(
            and(
              isNull(conversations.deletedAt),
              ilike(conversations.title, `%${q.replace(/[%_]/g, "")}%`),
            ),
          )
          .limit(10),
      ])

      const semanticHits: z.infer<typeof hitSchema>[] = []
      if (semantic) {
        const { vector } = await embedOne(q)
        const distance = cosineDistance(messageEmbeddings.embedding, vector)
        const rows = await db
          .select({
            conversationId: conversations.id,
            title: conversations.title,
            messageId: messages.id,
            text: messages.contentText,
            score: sql<number>`1 - (${distance})`,
          })
          .from(messageEmbeddings)
          .innerJoin(messages, eq(messages.id, messageEmbeddings.messageId))
          .innerJoin(conversations, eq(conversations.id, messages.conversationId))
          .where(alive)
          .orderBy(distance)
          .limit(20)
        for (const row of rows) {
          if (row.score < 0.3) continue
          semanticHits.push({
            conversationId: row.conversationId,
            title: row.title,
            messageId: row.messageId,
            snippet: (row.text ?? "").slice(0, 220),
            score: row.score,
          })
        }
      }

      // Uma linha por conversa: título > texto > semântica.
      const byConversation = new Map<string, z.infer<typeof hitSchema>>()
      for (const hit of titleHits) {
        byConversation.set(hit.conversationId, {
          ...hit,
          messageId: null,
          snippet: hit.title ?? "",
          score: 2,
        })
      }
      for (const hit of textHits) {
        const current = byConversation.get(hit.conversationId)
        if (!current) byConversation.set(hit.conversationId, { ...hit, score: 1 + hit.score })
      }
      for (const hit of semanticHits) {
        if (!byConversation.has(hit.conversationId)) byConversation.set(hit.conversationId, hit)
      }

      const sinapseHits = await searchSinapses(q, 6).catch(() => [])
      return {
        conversations: [...byConversation.values()].sort((a, b) => b.score - a.score).slice(0, 20),
        sinapses: sinapseHits.map((hit) => ({
          id: hit.id,
          title: hit.title,
          snippet: hit.snippet,
        })),
      }
    },
  )
}
