/**
 * Categorização pela IA (F10/F11/F24), em lote e em background. Recebe descrição, valor, data e
 * conta; nunca cria categoria; abaixo do limiar de confiança deixa para você, com uma pergunta.
 */
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm"
import { zodTextFormat } from "openai/helpers/zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { finAccounts, finCategories, finTransactions } from "../../db/schema.js"
import { registerJob } from "../../lib/jobs.js"
import { openai } from "../../lib/openai.js"
import { fromResponsesUsage, recordUsage } from "../../lib/pricing.js"
import { getSettings } from "../settings/service.js"
import { getFinanceSettings } from "./service.js"

const BATCH = 40
const MAX_ROUNDS = 5

const resultSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      /** Id de uma das categorias dadas, ou null quando não há certeza. */
      categoryId: z.string().nullable(),
      confidence: z.number(),
      /** Até 3 ids de categorias prováveis, para os botões da revisão. */
      alternatives: z.array(z.string()),
      /** Pergunta curta para o usuário quando categoryId é null. */
      question: z.string().nullable(),
    }),
  ),
})

const INSTRUCTIONS = [
  "Você categoriza lançamentos de extrato bancário de uma pessoa no Brasil.",
  "Use só os ids das categorias da lista. Nunca invente categoria.",
  "Se não tiver certeza, devolva categoryId null, confiança baixa, até 3 alternativas e uma pergunta curta em pt-BR.",
  "Lojas e lançamentos genéricos (Amazon, Mercado Livre, Shopee, Magalu, PIX ENVIADO, PIX RECEBIDO, PIX QR CODE, " +
    "TED, transferências para pessoas) quase sempre ficam com categoryId null e uma pergunta.",
  "Valor negativo é saída de dinheiro; positivo é entrada. Categorias de receita só para entradas, " +
    "exceto estornos (entrada numa categoria de despesa).",
  "Quando houver exemplos confirmados do mesmo estabelecimento, siga-os.",
].join("\n")

/** Uma rodada: até BATCH transações ainda não vistas pela IA. Devolve quantas processou. */
export async function categorizeRound(): Promise<number> {
  const pending = await db
    .select()
    .from(finTransactions)
    .where(
      and(
        eq(finTransactions.status, "review"),
        eq(finTransactions.class, "normal"),
        isNull(finTransactions.aiTriedAt),
        isNull(finTransactions.deletedAt),
      ),
    )
    .limit(BATCH)
  if (!pending.length) return 0

  const categories = await db.select().from(finCategories).where(isNull(finCategories.archivedAt))
  const valid = new Map(categories.map((c) => [c.id, c]))
  const accounts = new Map((await db.select().from(finAccounts)).map((a) => [a.id, a]))
  if (!categories.length) {
    // Sem categorias não há o que sugerir; marca como vistas para não tentar de novo.
    await markTried(pending.map((t) => t.id))
    return pending.length
  }

  // Exemplos: até 3 lançamentos confirmados do mesmo estabelecimento.
  const merchants = [...new Set(pending.map((t) => t.merchant).filter((m): m is string => !!m))]
  const confirmed = merchants.length
    ? await db
        .select({ merchant: finTransactions.merchant, categoryId: finTransactions.categoryId })
        .from(finTransactions)
        .where(
          and(
            inArray(finTransactions.merchant, merchants),
            isNotNull(finTransactions.categoryId),
            inArray(finTransactions.categorySource, ["user", "rule"]),
            isNull(finTransactions.deletedAt),
          ),
        )
        .orderBy(desc(finTransactions.date))
    : []
  const examples = new Map<string, string[]>()
  for (const row of confirmed) {
    const list = examples.get(row.merchant!) ?? []
    const name = valid.get(row.categoryId!)?.name
    if (name && list.length < 3) list.push(name)
    examples.set(row.merchant!, list)
  }

  const { backgroundModel } = await getSettings()
  const { aiConfidenceThreshold } = await getFinanceSettings()
  const input =
    "## Categorias\n" +
    categories
      .map((c) => `- ${c.id} · ${c.name} (${c.kind === "income" ? "receita" : "despesa"})`)
      .join("\n") +
    "\n\n## Lançamentos\n" +
    pending
      .map((t) => {
        const account = accounts.get(t.accountId)
        const ex = t.merchant ? examples.get(t.merchant) : undefined
        return (
          `- id=${t.id} · ${t.date} · ${(t.amount / 100).toFixed(2)} · ${account?.type === "credit_card" ? "cartão" : "conta"} · ` +
          `"${t.originalDescription ?? t.description}"` +
          (ex?.length ? ` · já categorizado antes como: ${ex.join(", ")}` : "")
        )
      })
      .join("\n")

  const response = await openai().responses.parse({
    model: backgroundModel,
    store: false,
    instructions: INSTRUCTIONS,
    input,
    text: { format: zodTextFormat(resultSchema, "categorization") },
  })
  await recordUsage({
    source: "background",
    model: backgroundModel,
    usage: fromResponsesUsage(response.usage),
  })

  const byId = new Map((response.output_parsed?.items ?? []).map((item) => [item.id, item]))
  for (const tx of pending) {
    const item = byId.get(tx.id)
    const category = item?.categoryId ? valid.get(item.categoryId) : undefined
    // Receita numa saída só faz sentido como estorno; na dúvida, pergunta.
    const plausible = category && (category.kind === "expense" || tx.amount > 0)
    const confidence = Math.max(0, Math.min(1, item?.confidence ?? 0))
    const alternatives = [item?.categoryId, ...(item?.alternatives ?? [])]
      .filter((id): id is string => !!id && valid.has(id))
      .filter((id, i, all) => all.indexOf(id) === i)
      .slice(0, 3)
    if (category && plausible && confidence >= aiConfidenceThreshold) {
      await db
        .update(finTransactions)
        .set({
          categoryId: category.id,
          categorySource: "ai",
          status: "auto",
          aiConfidence: confidence,
          aiTriedAt: new Date(),
          aiQuestion: null,
          aiSuggestions: alternatives,
        })
        .where(and(eq(finTransactions.id, tx.id), eq(finTransactions.status, "review")))
    } else {
      await db
        .update(finTransactions)
        .set({
          aiConfidence: item ? confidence : null,
          aiTriedAt: new Date(),
          aiQuestion:
            tx.aiQuestion ??
            item?.question?.trim()?.slice(0, 300) ??
            "Não tenho certeza. Qual categoria?",
          aiSuggestions: alternatives,
        })
        .where(and(eq(finTransactions.id, tx.id), eq(finTransactions.status, "review")))
    }
  }
  return pending.length
}

async function markTried(ids: string[]) {
  if (ids.length)
    await db
      .update(finTransactions)
      .set({ aiTriedAt: new Date() })
      .where(inArray(finTransactions.id, ids))
}

registerJob("finance.categorize", async () => {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if ((await categorizeRound()) < BATCH) break
  }
})
