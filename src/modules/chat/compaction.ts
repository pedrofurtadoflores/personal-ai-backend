/**
 * Orçamento de contexto (D67). O histórico enviado a cada resposta tem um teto; acima dele, o
 * começo do ramo vira um resumo feito pelo modelo de background, guardado em
 * `conversation_summaries` e preso a uma mensagem (vale para qualquer ramo que passe por ela).
 * As mensagens originais continuam no banco (D27); só deixam de ir para o modelo.
 */
import { and, desc, eq } from "drizzle-orm"
import { db } from "../../db/client.js"
import { conversationSummaries } from "../../db/schema.js"
import { truncate } from "../../lib/chunk.js"
import { registerJob } from "../../lib/jobs.js"
import { openai } from "../../lib/openai.js"
import { fromResponsesUsage, modelPrices, recordUsage } from "../../lib/pricing.js"
import { branchTo, getConversation, listMessages, type Message } from "../conversations/service.js"
import { getSettings } from "../settings/service.js"
import type { MessagePart } from "./parts.js"

/** Fração do orçamento que fica com as mensagens recentes, inteiras, depois de resumir. */
const KEEP_RATIO = 0.4
/** O job em background resume antes de a conversa chegar no teto. */
export const BACKGROUND_RATIO = 0.75
const MAX_MESSAGE_CHARS = 8_000
const MAX_TRANSCRIPT_CHARS = 160_000

/** Estimativa sem tokenizador: ~3,5 caracteres por token em pt-BR. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5)

/** Tokens aproximados de uma mensagem do ramo, com anexos. */
export function messageTokens(message: Message) {
  let tokens = 4
  for (const part of message.content as MessagePart[]) {
    if (part.type === "text") tokens += estimateTokens(part.text)
    else if (part.type === "file") tokens += part.mime.startsWith("image/") ? 1_000 : 3_000
    else if (part.type === "image") tokens += 1_000
    else if (part.type === "mention") tokens += 1_500
    else if (part.type === "sources") tokens += 25 * part.items.length
  }
  return tokens
}

/** Teto de tokens por resposta: o da configuração, limitado pela janela do modelo. */
export async function contextBudget(model: string) {
  const { contextBudgetTokens } = await getSettings()
  const window = (await modelPrices(model))?.contextWindow
  return window ? Math.min(contextBudgetTokens, Math.floor(window * 0.75)) : contextBudgetTokens
}

export type Compaction = {
  summary: string | null
  /** Índice do ramo a partir do qual as mensagens vão inteiras. */
  startIndex: number
  /** Mensagens que ficaram de fora sem resumo (o resumo falhou). */
  dropped: number
}

/** Resumo mais recente cuja mensagem final está no ramo (e não é a última). */
async function summaryFor(conversationId: string, branch: Message[]) {
  const position = new Map(branch.map((message, index) => [message.id, index]))
  const rows = await db
    .select()
    .from(conversationSummaries)
    .where(eq(conversationSummaries.conversationId, conversationId))
    .orderBy(desc(conversationSummaries.createdAt))
  let best: { summary: string; index: number } | null = null
  for (const row of rows) {
    const index = position.get(row.upToMessageId)
    if (index === undefined || index >= branch.length - 1) continue
    if (!best || index > best.index) best = { summary: row.summary, index }
  }
  return best
}

/** O que a resposta guardou sobre o contexto com que foi gerada (ver orchestrator). */
export type ContextParams = {
  /** Primeira mensagem do ramo que foi inteira (o resto entrou como resumo). */
  historyFrom?: string | null
  /** Tokens reais de entrada da primeira rodada (instruções + histórico + anexos). */
  contextTokens?: number
}

/** Tokens projetados para mandar `branch` a partir de `start`. */
function projectedTokens(branch: Message[], start: number, fixedTokens: number) {
  const rest = branch.slice(start)
  const estimate = fixedTokens + rest.reduce((sum, message) => sum + messageTokens(message), 0)
  // Calibra com o número real da última resposta gerada com o mesmo começo de histórico.
  const startId = rest[0]?.id ?? null
  const lastIndex = rest.findLastIndex((message) => {
    const params = (message.params ?? {}) as ContextParams
    return (
      message.role === "assistant" &&
      (params.contextTokens ?? 0) > 0 &&
      (params.historyFrom ?? branch[0]!.id) === startId
    )
  })
  if (lastIndex < 0) return estimate
  const last = rest[lastIndex]!
  const measured =
    (last.params as ContextParams).contextTokens! +
    Math.max((last.tokensOut ?? 0) - (last.tokensReasoning ?? 0), 0) +
    rest.slice(lastIndex + 1).reduce((sum, message) => sum + messageTokens(message), 0)
  return Math.max(estimate, measured)
}

function transcript(messages: Message[]) {
  const lines = messages.map((message) => {
    const parts = message.content as MessagePart[]
    const extras = parts.flatMap((part) => {
      if (part.type === "file") return [`[anexo: ${part.name}]`]
      if (part.type === "image") return [`[imagem gerada: ${part.prompt ?? "sem descrição"}]`]
      if (part.type === "mention") return [`[sinapse mencionada: ${part.title}]`]
      return []
    })
    const text = truncate(
      parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n"),
      MAX_MESSAGE_CHARS,
    )
    const who = message.role === "user" ? "Usuário" : "Assistente"
    return `${who}: ${[...extras, text].filter(Boolean).join("\n")}`
  })
  const full = lines.join("\n\n")
  // Muito longo: mantém o fim, que é o que mais importa para continuar a conversa.
  return full.length <= MAX_TRANSCRIPT_CHARS
    ? full
    : `[… início cortado …]\n\n${full.slice(-MAX_TRANSCRIPT_CHARS)}`
}

async function summarize(previous: string | null, messages: Message[]) {
  const { backgroundModel } = await getSettings()
  const response = await openai().responses.create({
    model: backgroundModel,
    store: false,
    instructions:
      "Você resume conversas para servir de memória de curto prazo a um assistente que vai continuar o diálogo. " +
      "Escreva em pt-BR, em tópicos densos. Preserve: o objetivo do usuário, decisões tomadas, fatos e dados " +
      "concretos (nomes, números, datas, trechos de código ou comandos importantes), pedidos ainda em aberto e " +
      "preferências expressas na conversa. Se houver um resumo anterior, incorpore-o. Não invente nada.",
    input:
      (previous ? `## Resumo anterior\n\n${previous}\n\n` : "") +
      `## Conversa a resumir\n\n${transcript(messages)}`,
  })
  await recordUsage({
    source: "background",
    model: backgroundModel,
    usage: fromResponsesUsage(response.usage),
  })
  const summary = response.output_text.trim()
  if (!summary) throw new Error("Resumo vazio")
  return { summary, model: backgroundModel }
}

/**
 * Garante que o ramo cabe no orçamento: usa o resumo existente e, se ainda não couber, resume
 * mais um trecho. Se o resumo falhar, as mensagens antigas ficam de fora (`dropped`).
 */
export async function compactBranch(params: {
  conversationId: string
  branch: Message[]
  budget: number
  /** Tokens fixos de cada chamada (instruções, memória). */
  fixedTokens: number
  /** Resume quando passar desta fração do orçamento (o job usa menos que 1). */
  threshold?: number
  onSummarizing?: () => void
}): Promise<Compaction> {
  const { conversationId, branch, budget, fixedTokens, threshold = 1 } = params
  const existing = await summaryFor(conversationId, branch)
  const start = existing ? existing.index + 1 : 0
  const current = { summary: existing?.summary ?? null, startIndex: start, dropped: 0 }
  const summaryTokens = current.summary ? estimateTokens(current.summary) : 0
  if (projectedTokens(branch, start, fixedTokens + summaryTokens) <= budget * threshold) {
    return current
  }

  // Mantém o fim inteiro (até KEEP_RATIO do orçamento) começando numa pergunta do usuário.
  let cut = branch.length - 1
  let kept = messageTokens(branch[cut]!)
  while (cut - 1 > start && kept + messageTokens(branch[cut - 1]!) <= budget * KEEP_RATIO) {
    cut -= 1
    kept += messageTokens(branch[cut]!)
  }
  while (cut < branch.length - 1 && branch[cut]!.role !== "user") cut += 1
  if (cut <= start) return current

  params.onSummarizing?.()
  try {
    const { summary, model } = await summarize(current.summary, branch.slice(start, cut))
    await db.insert(conversationSummaries).values({
      conversationId,
      upToMessageId: branch[cut - 1]!.id,
      summary,
      messagesCount: cut,
      model,
    })
    return { summary, startIndex: cut, dropped: 0 }
  } catch {
    return { summary: current.summary, startIndex: cut, dropped: cut - start }
  }
}

/** Job: resume em background quando o ramo atual passa de 75% do orçamento. */
export async function compactConversation(conversationId: string) {
  const conversation = await getConversation(conversationId).catch(() => null)
  if (!conversation) return
  const branch = branchTo(await listMessages(conversationId), conversation.currentLeafMessageId)
  if (branch.length < 3) return
  const { chatDefaultModel } = await getSettings()
  const model = conversation.model || chatDefaultModel
  await compactBranch({
    conversationId,
    branch,
    budget: await contextBudget(model),
    fixedTokens: 0,
    threshold: BACKGROUND_RATIO,
  })
}

/** Precisa do job? (chamado depois de cada resposta, com o ramo já completo). */
export async function needsCompaction(conversationId: string, branch: Message[], model: string) {
  const budget = await contextBudget(model)
  const existing = await summaryFor(conversationId, branch)
  const start = existing ? existing.index + 1 : 0
  const fixed = existing ? estimateTokens(existing.summary) : 0
  return projectedTokens(branch, start, fixed) > budget * BACKGROUND_RATIO
}

registerJob<{ conversationId: string }>("conversation.compact", ({ conversationId }) =>
  compactConversation(conversationId),
)

/** Usado pelos testes e pelo fork: resumos de uma conversa. */
export function summariesOf(conversationId: string, upToMessageId?: string) {
  return db
    .select()
    .from(conversationSummaries)
    .where(
      and(
        eq(conversationSummaries.conversationId, conversationId),
        upToMessageId ? eq(conversationSummaries.upToMessageId, upToMessageId) : undefined,
      ),
    )
}
