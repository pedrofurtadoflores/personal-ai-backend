import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm"
import { db } from "../../db/client.js"
import { conversations, messageEmbeddings, messages } from "../../db/schema.js"
import { truncate } from "../../lib/chunk.js"
import { embed } from "../../lib/embeddings.js"
import { registerJob } from "../../lib/jobs.js"
import { openai } from "../../lib/openai.js"
import { fromResponsesUsage, recordUsage } from "../../lib/pricing.js"
import { branchTo, listMessages } from "../conversations/service.js"
import { getSettings } from "../settings/service.js"

/** Título automático em pt-BR a partir do começo da conversa. */
export async function generateTitle(conversationId: string) {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
  if (!conversation || conversation.title) return
  const all = await listMessages(conversationId)
  const branch = branchTo(all, conversation.currentLeafMessageId).slice(0, 2)
  const excerpt = branch
    .map((message) => `${message.role}: ${truncate(message.contentText ?? "", 1_500)}`)
    .join("\n")
  if (!excerpt.trim()) return

  const { backgroundModel } = await getSettings()
  const response = await openai().responses.create({
    model: backgroundModel,
    store: false,
    instructions:
      "Crie um título curto (no máximo 6 palavras) em pt-BR para esta conversa. Responda só com o título, sem aspas nem ponto final.",
    input: excerpt,
  })
  await recordUsage({
    source: "background",
    model: backgroundModel,
    usage: fromResponsesUsage(response.usage),
  })
  const title = response.output_text
    .trim()
    .replace(/^["'«]|["'»]$/g, "")
    .slice(0, 80)
  if (title) {
    await db
      .update(conversations)
      .set({ title, updatedAt: conversation.updatedAt })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.title)))
  }
}

/** Embeddings das mensagens, para a busca semântica no histórico. */
export async function embedMessages(messageIds: string[]) {
  const rows = await db
    .select({ id: messages.id, text: messages.contentText })
    .from(messages)
    .where(and(inArray(messages.id, messageIds), isNotNull(messages.contentText)))
  const withText = rows.filter((row) => row.text?.trim())
  if (!withText.length) return
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

registerJob<{ conversationId: string }>("conversation.title", ({ conversationId }) =>
  generateTitle(conversationId),
)
registerJob<{ messageIds: string[] }>("messages.embed", ({ messageIds }) =>
  embedMessages(messageIds),
)
