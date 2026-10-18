import { and, asc, eq, isNull, notInArray } from "drizzle-orm"
import { zodTextFormat } from "openai/helpers/zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { modelCatalog } from "../../db/schema.js"
import { registerJob } from "../../lib/jobs.js"
import { openai } from "../../lib/openai.js"
import { clearPriceCache, fromResponsesUsage, recordUsage } from "../../lib/pricing.js"
import { getSettings, internalKeys, setInternal } from "../settings/service.js"
import { catalogSeed, classifyModel, isSnapshotId } from "./catalog-seed.js"

const MAX_DRAFTS_PER_SYNC = 10

/**
 * Sincroniza o catálogo com o /v1/models da conta (D11). Preços e textos editados
 * no painel nunca são sobrescritos; modelos que sumiram da conta ficam `available=false`.
 */
export async function syncModels() {
  const ids: { id: string; created: number }[] = []
  for await (const model of openai().models.list())
    ids.push({ id: model.id, created: model.created })

  const now = new Date()
  const seen: string[] = []
  for (const { id, created } of ids) {
    const kind = classifyModel(id)
    if (!kind) continue
    seen.push(id)
    const seed = catalogSeed[id]
    await db
      .insert(modelCatalog)
      .values({
        id,
        kind,
        isSnapshot: isSnapshotId(id),
        displayName: seed?.name ?? null,
        inputPrice: seed?.input ?? null,
        cachedInputPrice: seed?.cached ?? null,
        outputPrice: seed?.output ?? null,
        extraPrices: seed?.extra ?? {},
        recommendation: seed?.recommendation ?? null,
        example: seed?.example ?? null,
        hasMetadata: seed?.input != null || seed?.extra != null,
        available: true,
        openaiCreatedAt: new Date(created * 1000),
        lastSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: modelCatalog.id,
        set: { kind, available: true, lastSyncedAt: now, isSnapshot: isSnapshotId(id) },
      })
  }

  if (seen.length) {
    await db.update(modelCatalog).set({ available: false }).where(notInArray(modelCatalog.id, seen))
  }
  await setInternal(internalKeys.modelsSyncedAt, now.toISOString())
  clearPriceCache()

  const drafted = await draftMissingDescriptions()
  return { total: seen.length, drafted }
}

const draftSchema = z.object({
  displayName: z.string(),
  recommendation: z.string(),
  example: z.string(),
})

/**
 * Para modelos de chat novos, sem texto no catálogo, o modelo de background escreve um
 * rascunho de recomendação e exemplo (D11). Preços nunca são inventados: ficam vazios.
 */
async function draftMissingDescriptions() {
  const missing = await db
    .select()
    .from(modelCatalog)
    .where(
      and(
        eq(modelCatalog.kind, "chat"),
        eq(modelCatalog.isSnapshot, false),
        eq(modelCatalog.available, true),
        isNull(modelCatalog.recommendation),
      ),
    )
    .orderBy(asc(modelCatalog.id))
    .limit(MAX_DRAFTS_PER_SYNC)
  if (!missing.length) return 0

  const { backgroundModel } = await getSettings()
  let drafted = 0
  for (const model of missing) {
    try {
      const response = await openai().responses.parse({
        model: backgroundModel,
        store: false,
        instructions:
          "Você escreve o catálogo de modelos de um app pessoal. Em pt-BR, dê um nome amigável, " +
          "uma recomendação de uso em uma frase e um exemplo curto de pergunta. Baseie-se só no id " +
          "do modelo; se não souber o que ele faz, diga que é desconhecido em vez de inventar.",
        input: `Id do modelo: ${model.id}`,
        text: { format: zodTextFormat(draftSchema, "model_draft") },
      })
      await recordUsage({
        source: "background",
        model: backgroundModel,
        usage: fromResponsesUsage(response.usage),
      })
      const draft = response.output_parsed
      if (!draft) continue
      await db
        .update(modelCatalog)
        .set({
          displayName: model.displayName ?? draft.displayName,
          recommendation: `${draft.recommendation} (rascunho automático)`,
          example: draft.example,
        })
        .where(eq(modelCatalog.id, model.id))
      drafted += 1
    } catch {
      // Rascunho é opcional: tenta de novo no próximo sync.
    }
  }
  return drafted
}

registerJob("models.sync", async () => {
  await syncModels()
})
