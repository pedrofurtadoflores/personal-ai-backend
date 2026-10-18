import { and, desc, gte, isNotNull, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { conversations, messages, usageEvents } from "../../db/schema.js"
import { withErrors } from "../../lib/http.js"
import { getSettings } from "../settings/service.js"

// Literal (não parâmetro): o Postgres trata $1, $2… como expressões diferentes e o GROUP BY falharia.
const TZ = sql.raw("'America/Sao_Paulo'")

const usageSummary = z.object({
  days: z.array(z.object({ date: z.string(), costUsd: z.number(), tokens: z.number() })),
  byModel: z.array(
    z.object({
      model: z.string(),
      costUsd: z.number(),
      tokensIn: z.number(),
      tokensOut: z.number(),
    }),
  ),
  bySource: z.array(z.object({ source: z.string(), costUsd: z.number() })),
  topConversations: z.array(
    z.object({ id: z.string(), title: z.string().nullable(), costUsd: z.number() }),
  ),
  month: z.object({
    costUsd: z.number(),
    limitUsd: z.number(),
    /** "ok" | "warning" (passou do limite de alerta) | "exceeded" (passou do limite). Só alerta (D23). */
    alert: z.enum(["ok", "warning", "exceeded"]),
  }),
})

export async function monthStatus() {
  const { monthlyLimitUsd, alertThreshold } = await getSettings()
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8` })
    .from(usageEvents)
    .where(
      sql`${usageEvents.createdAt} >= date_trunc('month', now() at time zone ${TZ}) at time zone ${TZ}`,
    )
  const costUsd = row?.total ?? 0
  const alert: "ok" | "warning" | "exceeded" =
    monthlyLimitUsd <= 0
      ? "ok"
      : costUsd >= monthlyLimitUsd
        ? "exceeded"
        : costUsd >= monthlyLimitUsd * alertThreshold
          ? "warning"
          : "ok"
  return { costUsd, limitUsd: monthlyLimitUsd, alert }
}

export const usageRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/usage",
    {
      schema: {
        tags: ["usage"],
        summary: "Custo por dia, modelo, origem e conversa",
        querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
        response: withErrors({ 200: usageSummary }),
      },
    },
    async (request) => {
      const since = new Date(Date.now() - request.query.days * 86_400_000)
      const inRange = gte(usageEvents.createdAt, since)
      const day = sql<string>`to_char(${usageEvents.createdAt} at time zone ${TZ}, 'YYYY-MM-DD')`
      const cost = sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`

      const [days, byModel, bySource, topConversations, month] = await Promise.all([
        db
          .select({
            date: day,
            costUsd: cost,
            tokens: sql<number>`coalesce(sum(${usageEvents.tokensIn} + ${usageEvents.tokensOut}), 0)::int`,
          })
          .from(usageEvents)
          .where(inRange)
          .groupBy(day)
          .orderBy(day),
        db
          .select({
            model: usageEvents.model,
            costUsd: cost,
            tokensIn: sql<number>`coalesce(sum(${usageEvents.tokensIn}), 0)::int`,
            tokensOut: sql<number>`coalesce(sum(${usageEvents.tokensOut}), 0)::int`,
          })
          .from(usageEvents)
          .where(inRange)
          .groupBy(usageEvents.model)
          .orderBy(desc(cost)),
        db
          .select({ source: usageEvents.source, costUsd: cost })
          .from(usageEvents)
          .where(inRange)
          .groupBy(usageEvents.source)
          .orderBy(desc(cost)),
        db
          .select({
            id: conversations.id,
            title: conversations.title,
            costUsd: sql<number>`coalesce(sum(${messages.costUsd}), 0)::float8`,
          })
          .from(messages)
          .innerJoin(conversations, sql`${conversations.id} = ${messages.conversationId}`)
          .where(and(gte(messages.createdAt, since), isNotNull(messages.costUsd)))
          .groupBy(conversations.id, conversations.title)
          .orderBy(desc(sql`sum(${messages.costUsd})`))
          .limit(10),
        monthStatus(),
      ])

      return { days, byModel, bySource, topConversations, month }
    },
  )
}
