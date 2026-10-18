import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { env } from "../../config/env.js"
import { withErrors } from "../../lib/http.js"
import { enqueue } from "../../lib/jobs.js"
import { configureBucketCors } from "../../lib/r2.js"
import {
  appSettingsPatch,
  appSettingsSchema,
  getSettings,
  updateSettings,
  voices,
} from "./service.js"

export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/settings",
    {
      schema: {
        tags: ["settings"],
        summary: "Configurações do app",
        response: withErrors({
          200: z.object({ settings: appSettingsSchema, voices: z.array(z.string()) }),
        }),
      },
    },
    async () => ({ settings: await getSettings(), voices: [...voices] }),
  )

  app.patch(
    "/settings",
    {
      schema: {
        tags: ["settings"],
        summary: "Alterar configurações",
        body: appSettingsPatch,
        response: withErrors({
          200: z.object({ settings: appSettingsSchema, reindexing: z.boolean() }),
        }),
      },
    },
    async (request) => {
      const before = await getSettings()
      const settings = await updateSettings(request.body)
      // Trocar o modelo de embedding exige recalcular todos os vetores (seção 6.3).
      const reindexing = settings.embeddingModel !== before.embeddingModel
      if (reindexing) await enqueue("sinapses.reindex-all", {}, { singleton: true })
      return { settings, reindexing }
    },
  )

  app.post(
    "/settings/reindex",
    {
      schema: {
        tags: ["settings"],
        summary: "Recalcular todos os embeddings (sinapses, arquivos, mensagens)",
        response: withErrors({ 202: z.object({ queued: z.literal(true) }) }),
      },
    },
    async (_request, reply) => {
      await enqueue("sinapses.reindex-all", {}, { singleton: true })
      return reply.code(202).send({ queued: true as const })
    },
  )

  app.post(
    "/settings/storage-cors",
    {
      schema: {
        tags: ["settings"],
        summary: "Configurar o CORS do bucket R2 para as origens do front (D40)",
        response: withErrors({ 200: z.object({ origins: z.array(z.string()) }) }),
      },
    },
    async () => {
      await configureBucketCors(env.FRONTEND_URL)
      return { origins: env.FRONTEND_URL }
    },
  )
}
