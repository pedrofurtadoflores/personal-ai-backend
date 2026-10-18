import { and, asc, eq } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { modelCatalog, modelKind } from "../../db/schema.js"
import { notFound, withErrors } from "../../lib/http.js"
import { clearPriceCache } from "../../lib/pricing.js"
import { PRICES_SOURCE } from "./catalog-seed.js"
import { syncModels } from "./service.js"

const nullableUsd = z.number().min(0).nullable()

export const modelSchema = z.object({
  id: z.string(),
  kind: z.enum(modelKind.enumValues),
  isSnapshot: z.boolean(),
  displayName: z.string().nullable(),
  inputPrice: nullableUsd,
  cachedInputPrice: nullableUsd,
  outputPrice: nullableUsd,
  extraPrices: z.record(z.string(), z.number()),
  contextWindow: z.number().nullable(),
  recommendation: z.string().nullable(),
  example: z.string().nullable(),
  hasMetadata: z.boolean(),
  available: z.boolean(),
})

const patchBody = z
  .object({
    displayName: z.string().max(80).nullable(),
    inputPrice: nullableUsd,
    cachedInputPrice: nullableUsd,
    outputPrice: nullableUsd,
    extraPrices: z.record(z.string(), z.number().min(0)),
    contextWindow: z.number().int().positive().nullable(),
    recommendation: z.string().max(500).nullable(),
    example: z.string().max(500).nullable(),
  })
  .partial()

const toModel = (row: typeof modelCatalog.$inferSelect) => modelSchema.parse(row)

export const modelRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/models",
    {
      schema: {
        tags: ["models"],
        summary: "Catálogo de modelos (preço, recomendação, exemplo)",
        querystring: z.object({
          kind: z.enum(modelKind.enumValues).optional(),
          includeSnapshots: z.stringbool().default(false),
          includeUnavailable: z.stringbool().default(false),
        }),
        response: withErrors({
          200: z.object({ models: z.array(modelSchema), pricesSource: z.string() }),
        }),
      },
    },
    async (request) => {
      const { kind, includeSnapshots, includeUnavailable } = request.query
      const rows = await db
        .select()
        .from(modelCatalog)
        .where(
          and(
            kind ? eq(modelCatalog.kind, kind) : undefined,
            includeSnapshots ? undefined : eq(modelCatalog.isSnapshot, false),
            includeUnavailable ? undefined : eq(modelCatalog.available, true),
          ),
        )
        .orderBy(asc(modelCatalog.kind), asc(modelCatalog.id))
      return { models: rows.map(toModel), pricesSource: PRICES_SOURCE }
    },
  )

  app.patch(
    "/models/:id",
    {
      schema: {
        tags: ["models"],
        summary: "Editar preço e textos de um modelo",
        params: z.object({ id: z.string() }),
        body: patchBody,
        response: withErrors({ 200: modelSchema }),
      },
    },
    async (request) => {
      const [row] = await db
        .update(modelCatalog)
        .set({ ...request.body, hasMetadata: true })
        .where(eq(modelCatalog.id, request.params.id))
        .returning()
      if (!row) throw notFound("Modelo")
      clearPriceCache()
      return toModel(row)
    },
  )

  app.post(
    "/models/sync",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["models"],
        summary: "Sincronizar com o /v1/models da conta",
        response: withErrors({ 200: z.object({ total: z.number(), drafted: z.number() }) }),
      },
    },
    async () => syncModels(),
  )
}
