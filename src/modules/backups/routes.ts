import { desc, eq } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { backups } from "../../db/schema.js"
import { notFound, withErrors } from "../../lib/http.js"
import { r2 } from "../../lib/r2.js"
import { isoDate, jsonDates } from "../../lib/serialize.js"
import { runBackup } from "./service.js"

const backupSchema = z.object({
  id: z.string(),
  r2Key: z.string(),
  size: z.number().nullable(),
  status: z.enum(["running", "completed", "failed"]),
  error: z.string().nullable(),
  createdAt: isoDate,
  completedAt: isoDate.nullable(),
})

export const backupRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/backups",
    {
      schema: {
        tags: ["backups"],
        summary: "Backups do banco no R2",
        response: withErrors({ 200: z.object({ backups: z.array(backupSchema) }) }),
      },
    },
    async () => {
      const rows = await db.select().from(backups).orderBy(desc(backups.createdAt)).limit(20)
      return { backups: rows.map((row) => backupSchema.parse(jsonDates(row))) }
    },
  )

  app.post(
    "/backups",
    {
      config: { rateLimit: { max: 3, timeWindow: "10 minutes" } },
      schema: {
        tags: ["backups"],
        summary: "Fazer um backup agora",
        response: withErrors({ 201: backupSchema }),
      },
    },
    async (_request, reply) =>
      reply.code(201).send(backupSchema.parse(jsonDates(await runBackup()))),
  )

  app.get(
    "/backups/:id/download",
    {
      schema: {
        tags: ["backups"],
        summary: "URL assinada (15 min) para baixar um backup",
        params: z.object({ id: z.uuid() }),
        response: withErrors({ 200: z.object({ url: z.string() }) }),
      },
    },
    async (request) => {
      const [row] = await db.select().from(backups).where(eq(backups.id, request.params.id))
      if (!row || row.status !== "completed") throw notFound("Backup")
      const name = row.r2Key.split("/").pop()!
      return { url: await r2().presignGet(row.r2Key, { downloadName: name, expiresIn: 900 }) }
    },
  )
}
