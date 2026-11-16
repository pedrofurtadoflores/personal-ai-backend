import { eq, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { personas } from "../../db/schema.js"
import { notFound, withErrors } from "../../lib/http.js"
import { listPersonas, personaColumns, personaSchema } from "./service.js"

const fields = z.object({
  name: z.string().trim().min(1).max(40),
  emoji: z.string().trim().max(16).nullable(),
  description: z.string().trim().max(160),
  instructions: z.string().trim().min(1).max(8_000),
  position: z.number().int(),
})

export const personaRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/personas",
    {
      schema: {
        tags: ["personas"],
        summary: "Listar personas (D80). Sem persona = padrão.",
        response: withErrors({ 200: z.object({ personas: z.array(personaSchema) }) }),
      },
    },
    async () => ({ personas: await listPersonas() }),
  )

  app.post(
    "/personas",
    {
      schema: {
        tags: ["personas"],
        summary: "Criar persona",
        body: fields.omit({ position: true }).partial({ emoji: true, description: true }),
        response: withErrors({ 201: personaSchema }),
      },
    },
    async (request, reply) => {
      const [{ next } = { next: 0 }] = await db
        .select({ next: sql<number>`coalesce(max(${personas.position}), -1)::int + 1` })
        .from(personas)
      const { emoji, ...rest } = request.body
      const [row] = await db
        .insert(personas)
        .values({ ...rest, emoji: emoji || null, position: next })
        .returning(personaColumns)
      return reply.code(201).send(row!)
    },
  )

  app.patch(
    "/personas/:id",
    {
      schema: {
        tags: ["personas"],
        summary: "Editar persona (vale para as próximas respostas)",
        params: z.object({ id: z.uuid() }),
        body: fields.partial(),
        response: withErrors({ 200: personaSchema }),
      },
    },
    async (request) => {
      const { emoji, ...rest } = request.body
      const [row] = await db
        .update(personas)
        .set({
          ...rest,
          ...(emoji !== undefined ? { emoji: emoji || null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(personas.id, request.params.id))
        .returning(personaColumns)
      if (!row) throw notFound("Persona")
      return row
    },
  )

  app.delete(
    "/personas/:id",
    {
      schema: {
        tags: ["personas"],
        summary:
          "Apagar persona (as conversas dela voltam ao padrão; as respostas antigas mantêm o nome)",
        params: z.object({ id: z.uuid() }),
        response: withErrors({ 204: z.null() }),
      },
    },
    async (request, reply) => {
      const [row] = await db
        .delete(personas)
        .where(eq(personas.id, request.params.id))
        .returning({ id: personas.id })
      if (!row) throw notFound("Persona")
      return reply.code(204).send(null)
    },
  )
}
