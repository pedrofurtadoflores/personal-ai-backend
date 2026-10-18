import { and, asc, eq, isNull } from "drizzle-orm"
import { db } from "../../db/client.js"
import { conversations, messages } from "../../db/schema.js"
import { notFound } from "../../lib/http.js"

export type Conversation = typeof conversations.$inferSelect
export type Message = typeof messages.$inferSelect

export async function getConversation(id: string, { includeDeleted = false } = {}) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.id, id), includeDeleted ? undefined : isNull(conversations.deletedAt)),
    )
  if (!row) throw notFound("Conversa")
  return row
}

/** Todas as mensagens (de todos os ramos) da conversa, em ordem de criação. */
export async function listMessages(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.createdAt))
}

/** Caminho da raiz até `leafId` (o ramo exibido), em ordem. */
export function branchTo(all: Message[], leafId: string | null): Message[] {
  if (!leafId) return []
  const byId = new Map(all.map((message) => [message.id, message]))
  const path: Message[] = []
  let current = byId.get(leafId)
  const guard = new Set<string>()
  while (current && !guard.has(current.id)) {
    guard.add(current.id)
    path.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return path
}

/** Folha mais recente abaixo de uma mensagem (para trocar de ramo pela versão de um nó). */
export function latestLeafBelow(all: Message[], messageId: string): string {
  const children = new Map<string, Message[]>()
  for (const message of all) {
    if (!message.parentId) continue
    const list = children.get(message.parentId) ?? []
    list.push(message)
    children.set(message.parentId, list)
  }
  let current = messageId
  for (;;) {
    const next = children.get(current)
    if (!next?.length) return current
    current = next.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)).id
  }
}

export async function touchConversation(id: string, leafId?: string) {
  await db
    .update(conversations)
    .set({ updatedAt: new Date(), ...(leafId ? { currentLeafMessageId: leafId } : {}) })
    .where(eq(conversations.id, id))
}
