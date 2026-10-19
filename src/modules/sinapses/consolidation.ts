/**
 * Consolidação em background (seção 4.3b): depois que a conversa fica ociosa, um modelo
 * barato lê o trecho novo, extrai conhecimento durável e cria/atualiza sinapses,
 * evitando duplicatas por similaridade. Também sugere mesclas e conexões.
 */
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm"
import { zodTextFormat } from "openai/helpers/zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import {
  conversations,
  fileChunks,
  files,
  messageEmbeddings,
  messages,
  sinapseSuggestions,
  sinapses,
} from "../../db/schema.js"
import { chunkText, truncate } from "../../lib/chunk.js"
import { embed, embedOne } from "../../lib/embeddings.js"
import { enqueue, registerJob } from "../../lib/jobs.js"
import { openai } from "../../lib/openai.js"
import { fromResponsesUsage, recordUsage } from "../../lib/pricing.js"
import type { MessagePart } from "../chat/parts.js"
import { branchTo, listMessages } from "../conversations/service.js"
import { getSettings } from "../settings/service.js"
import {
  applySectionOperation,
  createSinapse,
  getSinapse,
  linkSinapses,
  reindexSinapse,
  similarSinapses,
  sinapseIndex,
  suggest,
  updateSinapse,
} from "./service.js"

const MAX_TRANSCRIPT_CHARS = 14_000
const DUPLICATE_THRESHOLD = 0.88
const MERGE_SUGGESTION_THRESHOLD = 0.93

const planSchema = z.object({
  items: z.array(
    z.object({
      action: z.enum(["create", "update"]),
      /** Id da sinapse a atualizar ("" em create). */
      sinapseId: z.string(),
      title: z.string(),
      emoji: z.string(),
      summary: z.string(),
      sectionTitle: z.string(),
      content: z.string(),
      tags: z.array(z.string()),
      reason: z.string(),
    }),
  ),
  links: z.array(z.object({ a: z.string(), b: z.string(), reason: z.string() })),
})

const guide = {
  conservative:
    "Seja conservador: só fatos claramente duradouros sobre o usuário, decisões e pedidos explícitos para lembrar.",
  balanced:
    "Guarde fatos duradouros, preferências, decisões, ideias de projeto, conselhos e reflexões úteis daqui a meses. Ignore o passageiro.",
  liberal: "Seja generoso: guarde tudo que possa ser útil no futuro.",
}

export async function consolidateConversation(conversationId: string, { force = false } = {}) {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
  if (!conversation || conversation.anonymous || conversation.deletedAt) return { applied: 0 }

  // Só consolida com a conversa ociosa: se chegou mensagem nova, reagenda para depois dela.
  const settings = await getSettings()
  const idleMs = Date.now() - conversation.updatedAt.getTime()
  const delayMs = settings.sinapsesConsolidationDelaySeconds * 1000
  if (!force && idleMs < delayMs - 5_000) {
    await enqueue(
      "sinapses.consolidate",
      { conversationId },
      { delaySeconds: Math.ceil((delayMs - idleMs) / 1000), key: `consolidate:${conversationId}` },
    )
    return { applied: 0, rescheduled: true }
  }

  const all = await listMessages(conversationId)
  const branch = branchTo(all, conversation.currentLeafMessageId)
  const since = conversation.lastConsolidatedAt
  const fresh = branch.filter(
    (message) =>
      message.status === "completed" &&
      (!since || message.createdAt > since) &&
      message.contentText,
  )
  if (!fresh.length) return { applied: 0 }

  // D37: conteúdo externo (anexos, busca web, página lida) → tudo vira sugestão.
  const external = fresh.some((message) =>
    (message.content as MessagePart[]).some(
      (part) =>
        part.type === "file" ||
        part.type === "sources" ||
        (part.type === "tool" && (part.name === "web_search" || part.name === "fetch_url")),
    ),
  )

  const transcript = truncate(
    fresh
      .map(
        (message) =>
          `${message.role === "user" ? "Usuário" : "Assistente"}: ${message.contentText}`,
      )
      .join("\n\n"),
    MAX_TRANSCRIPT_CHARS,
  )
  const { vector } = await embedOne(transcript.slice(0, 8_000))
  const [candidates, index] = await Promise.all([
    similarSinapses(vector, { limit: 8 }),
    sinapseIndex(80),
  ])

  // O que a IA já salvou durante a conversa (tools) e o conteúdo atual das sinapses mais
  // próximas: sem isso, a consolidação repetiria fatos que já estão guardados.
  const alreadySaved = fresh.flatMap((message) =>
    (message.content as MessagePart[])
      .filter((part) => part.type === "sinapse")
      .map((part) => `- ${part.action}: ${part.title}`),
  )
  const closest = await Promise.all(
    candidates.slice(0, 3).map(async (candidate) => {
      const sinapse = await getSinapse(candidate.id).catch(() => null)
      return sinapse
        ? `### ${sinapse.title} (id ${sinapse.id})\n\n${truncate(sinapse.content, 2_500)}`
        : ""
    }),
  )

  const response = await openai().responses.parse({
    model: settings.backgroundModel,
    store: false,
    instructions: [
      "Você mantém a memória de longo prazo (sinapses) de um assistente pessoal.",
      "Leia o trecho novo da conversa e decida o que vale guardar. Cada sinapse é um tema (ex.: Carreira, Ideias de projeto, Saúde, Filosofia).",
      guide[settings.sinapsesAggressiveness],
      "Regras: escreva em pt-BR (D25), em terceira pessoa sobre o usuário, objetivo. Prefira `update` numa sinapse existente do mesmo tema a criar outra.",
      "Em `update`, `content` é só a seção nova/atualizada e `sectionTitle` o título dela. Em `create`, `content` é o documento inicial em markdown.",
      "Nunca guarde segredos (senhas, tokens, números de documento). Se nada for durável, devolva listas vazias.",
      "Nunca repita o que já está no conteúdo das sinapses mostradas nem o que já foi salvo durante a conversa: só acrescente informação nova.",
      "`links` conecta ids de sinapses existentes que tenham relação clara.",
    ].join("\n"),
    input: [
      "## Sinapses existentes (índice)",
      index.map((item) => `- ${item.id} · ${item.title}: ${item.summary}`).join("\n") ||
        "(nenhuma)",
      "## Mais parecidas com este trecho",
      candidates
        .map((item) => `- ${item.id} · ${item.title} (similaridade ${item.score.toFixed(2)})`)
        .join("\n") || "(nenhuma)",
      "## Conteúdo atual das sinapses mais próximas",
      closest.filter(Boolean).join("\n\n") || "(nenhuma)",
      "## Já salvo durante esta conversa",
      alreadySaved.join("\n") || "(nada)",
      "## Trecho novo da conversa",
      transcript,
    ].join("\n\n"),
    text: { format: zodTextFormat(planSchema, "memory_plan") },
  })
  await recordUsage({
    source: "background",
    model: settings.backgroundModel,
    usage: fromResponsesUsage(response.usage),
  })

  const plan = response.output_parsed ?? { items: [], links: [] }
  const lastMessage = fresh[fresh.length - 1]!
  const context = { author: "ai" as const, sourceMessageId: lastMessage.id, conversationId }
  const touched = new Set<string>()
  let applied = 0

  for (const item of plan.items) {
    let targetId = item.action === "update" ? item.sinapseId : ""
    if (item.action === "create") {
      // Deduplicação: um tema muito parecido com um existente vira atualização dele.
      const { vector: itemVector } = await embedOne(`# ${item.title}\n\n${item.summary}`)
      const [twin] = await similarSinapses(itemVector, { limit: 1 })
      if (twin && twin.score >= DUPLICATE_THRESHOLD) targetId = twin.id
    }

    if (!targetId) {
      const input = {
        title: item.title,
        emoji: item.emoji || null,
        summary: item.summary,
        content: item.content,
        tags: item.tags,
      }
      if (external) await suggest(null, { kind: "create", input }, item.reason, lastMessage.id)
      else touched.add((await createSinapse(input, { ...context, reason: item.reason })).sinapse.id)
      applied += 1
      continue
    }

    const target = await getSinapse(targetId).catch(() => null)
    if (!target) continue
    const patch = {
      content: applySectionOperation(
        target.content,
        item.sectionTitle ? "replace_section" : "append_section",
        item.sectionTitle,
        item.content,
      ),
      ...(item.summary ? { summary: item.summary } : {}),
      tags: [...target.tags, ...item.tags],
    }
    if (external || target.locked) {
      await suggest(target.id, { kind: "update", patch }, item.reason, lastMessage.id)
    } else {
      await updateSinapse(target.id, patch, { ...context, reason: item.reason })
      touched.add(target.id)
    }
    applied += 1
  }

  for (const link of plan.links) {
    try {
      await linkSinapses(link.a, link.b, link.reason, "ai")
    } catch {
      // ids inválidos do modelo: ignora
    }
  }

  await suggestMerges([...touched])
  await db
    .update(conversations)
    // Preserva updated_at: consolidar não é atividade (não reordena a sidebar nem reinicia a espera).
    .set({ lastConsolidatedAt: lastMessage.createdAt, updatedAt: conversation.updatedAt })
    .where(eq(conversations.id, conversationId))
  return { applied }
}

/** Sinapses quase idênticas às recém-tocadas viram sugestão de mesclagem (seção 4.3b.4). */
async function suggestMerges(ids: string[]) {
  for (const id of ids) {
    const sinapse = await getSinapse(id).catch(() => null)
    if (!sinapse?.summaryEmbedding) continue
    const [twin] = await similarSinapses(sinapse.summaryEmbedding, { limit: 1, excludeId: id })
    if (!twin || twin.score < MERGE_SUGGESTION_THRESHOLD) continue
    const [pending] = await db
      .select({ id: sinapseSuggestions.id })
      .from(sinapseSuggestions)
      .where(
        and(
          eq(sinapseSuggestions.kind, "merge"),
          eq(sinapseSuggestions.status, "pending"),
          inArray(sinapseSuggestions.sinapseId, [id, twin.id]),
        ),
      )
    if (pending) continue
    await suggest(
      id,
      { kind: "merge", sourceIds: [twin.id] },
      `"${sinapse.title}" e "${twin.title}" parecem o mesmo tema.`,
    )
  }
}

/** Recalcula todos os embeddings (troca do modelo de embedding, seção 6.3). */
export async function reindexAll() {
  const rows = await db.select().from(sinapses).where(isNull(sinapses.deletedAt))
  for (const row of rows) await reindexSinapse(row)

  const fileRows = await db
    .select()
    .from(files)
    .where(and(isNull(files.deletedAt), eq(files.status, "ready")))
  for (const file of fileRows) {
    if (!file.extractedText) continue
    const pieces = chunkText(file.extractedText)
    const { model, vectors } = await embed(pieces.map((piece) => `${file.name}\n\n${piece}`))
    await db.delete(fileChunks).where(eq(fileChunks.fileId, file.id))
    if (pieces.length) {
      await db.insert(fileChunks).values(
        pieces.map((text, idx) => ({
          fileId: file.id,
          idx,
          text,
          embeddingModel: model,
          embedding: vectors[idx]!,
        })),
      )
    }
  }

  // Mensagens em lotes, em ordem.
  let cursor = new Date(0)
  for (;;) {
    const batch = await db
      .select({ id: messages.id, text: messages.contentText, createdAt: messages.createdAt })
      .from(messages)
      .where(and(gt(messages.createdAt, cursor), isNull(messages.deletedAt)))
      .orderBy(asc(messages.createdAt))
      .limit(200)
    if (!batch.length) break
    cursor = batch[batch.length - 1]!.createdAt
    const withText = batch.filter((row) => row.text?.trim())
    if (!withText.length) continue
    const { model, vectors } = await embed(withText.map((row) => row.text!))
    for (const [idx, row] of withText.entries()) {
      await db
        .insert(messageEmbeddings)
        .values({ messageId: row.id, embeddingModel: model, embedding: vectors[idx]! })
        .onConflictDoUpdate({
          target: messageEmbeddings.messageId,
          set: { embeddingModel: model, embedding: vectors[idx]! },
        })
    }
  }
}

registerJob<{ conversationId: string }>("sinapses.consolidate", async ({ conversationId }) => {
  await consolidateConversation(conversationId)
})
registerJob("sinapses.reindex-all", reindexAll)
