import { eq } from "drizzle-orm"
import { db } from "../db/client.js"
import { modelCatalog, usageEvents } from "../db/schema.js"

export type TokenUsage = {
  input: number
  cached: number
  output: number
  reasoning: number
}

export const emptyUsage = (): TokenUsage => ({ input: 0, cached: 0, output: 0, reasoning: 0 })

export function addUsage(total: TokenUsage, more: Partial<TokenUsage>) {
  total.input += more.input ?? 0
  total.cached += more.cached ?? 0
  total.output += more.output ?? 0
  total.reasoning += more.reasoning ?? 0
}

/** Converte o `usage` da Responses API para o nosso formato. */
export function fromResponsesUsage(usage: unknown): TokenUsage {
  const u = (usage ?? {}) as {
    input_tokens?: number
    output_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
  return {
    input: u.input_tokens ?? 0,
    cached: u.input_tokens_details?.cached_tokens ?? 0,
    output: u.output_tokens ?? 0,
    reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
  }
}

const priceCache = new Map<string, { at: number; row: typeof modelCatalog.$inferSelect | null }>()
const CACHE_MS = 60_000

/** Preços do modelo; snapshots datados herdam os do alias (gpt-5-2025-08-07 → gpt-5). */
export async function modelPrices(model: string) {
  const cached = priceCache.get(model)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.row
  const [row] = await db.select().from(modelCatalog).where(eq(modelCatalog.id, model))
  let result = row ?? null
  if ((!result || result.inputPrice == null) && /-\d{4}-\d{2}-\d{2}$/.test(model)) {
    const alias = model.replace(/-\d{4}-\d{2}-\d{2}$/, "")
    const [aliasRow] = await db.select().from(modelCatalog).where(eq(modelCatalog.id, alias))
    if (aliasRow) result = { ...aliasRow, id: model }
  }
  priceCache.set(model, { at: Date.now(), row: result })
  return result
}

export function clearPriceCache() {
  priceCache.clear()
}

/** Custo em USD de um uso de tokens de texto. Tokens em cache cobram o preço reduzido. */
export async function tokenCost(model: string, usage: TokenUsage): Promise<number> {
  const prices = await modelPrices(model)
  if (!prices?.inputPrice) return 0
  const cachedPrice = prices.cachedInputPrice ?? prices.inputPrice
  const uncached = Math.max(usage.input - usage.cached, 0)
  return (
    (uncached * prices.inputPrice +
      usage.cached * cachedPrice +
      usage.output * (prices.outputPrice ?? 0)) /
    1_000_000
  )
}

type UsageSource = (typeof usageEvents.$inferInsert)["source"]

/** Registra um consumo da OpenAI e devolve o custo calculado. */
export async function recordUsage(params: {
  source: UsageSource
  model: string
  usage?: TokenUsage
  units?: Record<string, number>
  costUsd?: number
  messageId?: string | null
}) {
  const usage = params.usage ?? emptyUsage()
  const costUsd = params.costUsd ?? (await tokenCost(params.model, usage))
  const int = (value: number) => Math.max(0, Math.round(value || 0))
  await db.insert(usageEvents).values({
    source: params.source,
    model: params.model,
    messageId: params.messageId ?? null,
    tokensIn: int(usage.input),
    tokensCached: int(usage.cached),
    tokensOut: int(usage.output),
    tokensReasoning: int(usage.reasoning),
    units: params.units ?? null,
    costUsd,
  })
  return costUsd
}
