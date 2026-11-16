import { eq } from "drizzle-orm"
import { db } from "../../db/client.js"
import { diaryEntries } from "../../db/schema.js"
import { truncate } from "../../lib/chunk.js"
import { registerJob } from "../../lib/jobs.js"
import { memorizeText } from "../sinapses/consolidation.js"
import { entryWithTurns, transcriptOf } from "./service.js"

const MAX_TRANSCRIPT_CHARS = 14_000

/**
 * O diário vira memória (D81): depois de concluída, cada entrada passa pelo mesmo caminho da
 * consolidação das conversas e cria/atualiza sinapses. É texto do próprio usuário, então
 * não é tratado como conteúdo externo. Roda uma vez por entrada (`memorized_at`).
 */
export async function memorizeEntry(entryId: string) {
  const [entry] = await db.select().from(diaryEntries).where(eq(diaryEntries.id, entryId))
  if (!entry || entry.deletedAt || entry.status !== "concluded" || entry.memorizedAt) {
    return { applied: 0 }
  }
  const full = await entryWithTurns(entryId)
  const { applied } = await memorizeText({
    transcript: truncate(transcriptOf(full), MAX_TRANSCRIPT_CHARS),
    external: false,
    sourceMessageId: null,
    conversationId: null,
    kind: "diário",
  })
  await db.update(diaryEntries).set({ memorizedAt: new Date() }).where(eq(diaryEntries.id, entryId))
  return { applied }
}

registerJob<{ entryId: string }>("diary.memorize", async ({ entryId }) => {
  await memorizeEntry(entryId)
})
