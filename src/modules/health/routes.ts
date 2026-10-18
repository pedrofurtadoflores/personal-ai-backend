import { sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { db } from "../../db/client.js"

const healthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["ok", "down"]),
})

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/health",
    {
      config: { public: true },
      schema: {
        tags: ["health"],
        summary: "Status do servidor e do banco",
        security: [],
        response: { 200: healthResponse, 503: healthResponse },
      },
    },
    async (_request, reply) => {
      try {
        await db.execute(sql`select 1`)
        return { status: "ok" as const, db: "ok" as const }
      } catch {
        return reply.code(503).send({ status: "degraded", db: "down" })
      }
    },
  )
}
