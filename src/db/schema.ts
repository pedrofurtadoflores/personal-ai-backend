import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core"

/** Dimensão dos embeddings. Trocar exige migration + reindexação (ver plan.md, 6.3). */
export const EMBEDDING_DIMENSIONS = 1536

const id = () => uuid().primaryKey().defaultRandom()
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())
const deletedAt = () => timestamp({ withTimezone: true })
const embedding = () => vector({ dimensions: EMBEDDING_DIMENSIONS })
/** Modelo que gerou o embedding: permite saber o que reindexar ao trocar de modelo. */
const embeddingModel = () => text().notNull()
const usd = () => numeric({ precision: 14, scale: 8, mode: "number" })

/** Coluna de busca full-text, sempre gerada pelo Postgres (nunca escrita pela aplicação). */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" })

// ─── Enums ──────────────────────────────────────────────────────────────────

export const messageRole = pgEnum("message_role", ["user", "assistant", "system", "tool"])
export const messageStatus = pgEnum("message_status", [
  "streaming",
  "completed",
  "stopped",
  "error",
])
export const author = pgEnum("author", ["ai", "user"])
export const sinapseStatus = pgEnum("sinapse_status", ["active", "archived"])
export const suggestionKind = pgEnum("suggestion_kind", ["create", "update", "merge", "link"])
export const suggestionStatus = pgEnum("suggestion_status", ["pending", "accepted", "rejected"])
export const fileStatus = pgEnum("file_status", [
  "pending",
  "uploaded",
  "processing",
  "ready",
  "error",
])
export const toolCallStatus = pgEnum("tool_call_status", ["pending", "completed", "error"])
export const usageSource = pgEnum("usage_source", [
  "chat",
  "background",
  "embedding",
  "image",
  "transcription",
  "speech",
  "realtime",
])

// ─── Conversas e mensagens ──────────────────────────────────────────────────

export const folders = pgTable("folders", {
  id: id(),
  name: text().notNull(),
  position: integer().notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    title: text(),
    folderId: uuid().references(() => folders.id, { onDelete: "set null" }),
    model: text(),
    systemPrompt: text(),
    /** temperatura, reasoning effort, tools ligadas etc. */
    settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Modo anônimo: não lê nem escreve sinapses. */
    anonymous: boolean().notNull().default(false),
    pinned: boolean().notNull().default(false),
    archived: boolean().notNull().default(false),
    /** Folha do ramo atualmente exibido na árvore de mensagens. */
    currentLeafMessageId: uuid().references((): AnyPgColumn => messages.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index().on(t.updatedAt), index().on(t.folderId)],
)

/**
 * Histórico completo (D27): toda pergunta e resposta é uma linha.
 * Editar/regenerar cria uma linha irmã (mesmo parent_id); nada é sobrescrito.
 */
export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    // Cascade: apagar de vez uma mensagem apaga o ramo abaixo dela, sem deixar filhas órfãs.
    // No uso normal nada é apagado de vez (soft delete via deleted_at, D27).
    parentId: uuid().references((): AnyPgColumn => messages.id, { onDelete: "cascade" }),
    role: messageRole().notNull(),
    /** Partes da mensagem (texto, imagens, arquivos, fontes, chips de sinapse...). */
    content: jsonb().$type<unknown[]>().notNull().default([]),
    /** Texto puro, para busca full-text e embeddings. */
    contentText: text(),
    searchVector: tsvector().generatedAlwaysAs(
      sql`to_tsvector('portuguese', coalesce(content_text, ''))`,
    ),
    model: text(),
    params: jsonb().$type<Record<string, unknown>>(),
    status: messageStatus().notNull().default("completed"),
    error: text(),
    openaiResponseId: text(),
    tokensIn: integer(),
    tokensCached: integer(),
    tokensOut: integer(),
    tokensReasoning: integer(),
    costUsd: usd(),
    createdAt: createdAt(),
    completedAt: timestamp({ withTimezone: true }),
    deletedAt: deletedAt(),
  },
  (t) => [
    index().on(t.conversationId, t.createdAt),
    index().on(t.parentId),
    index().using("gin", t.searchVector),
  ],
)

export const messageEmbeddings = pgTable(
  "message_embeddings",
  {
    messageId: uuid()
      .primaryKey()
      .references(() => messages.id, { onDelete: "cascade" }),
    embeddingModel: embeddingModel(),
    embedding: embedding().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().using("hnsw", t.embedding.op("vector_cosine_ops"))],
)

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: id(),
    messageId: uuid()
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    callId: text(),
    name: text().notNull(),
    input: jsonb(),
    output: jsonb(),
    status: toolCallStatus().notNull().default("completed"),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.messageId)],
)

// ─── Sinapses ───────────────────────────────────────────────────────────────

export const sinapses = pgTable(
  "sinapses",
  {
    id: id(),
    title: text().notNull(),
    emoji: text(),
    summary: text().notNull().default(""),
    content: text().notNull().default(""),
    tags: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: sinapseStatus().notNull().default("active"),
    /** Travada: a IA não edita, só sugere (D21). */
    locked: boolean().notNull().default(false),
    /** Fixada: sempre entra no contexto do chat. */
    pinned: boolean().notNull().default(false),
    createdBy: author().notNull(),
    summaryEmbedding: embedding(),
    summaryEmbeddingModel: text(),
    searchVector: tsvector().generatedAlwaysAs(
      sql`setweight(to_tsvector('portuguese', title), 'A') || setweight(to_tsvector('portuguese', summary), 'B') || setweight(to_tsvector('portuguese', content), 'C')`,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index().using("hnsw", t.summaryEmbedding.op("vector_cosine_ops")),
    index().using("gin", t.tags),
    index().using("gin", t.searchVector),
  ],
)

export const sinapseChunks = pgTable(
  "sinapse_chunks",
  {
    id: id(),
    sinapseId: uuid()
      .notNull()
      .references(() => sinapses.id, { onDelete: "cascade" }),
    idx: integer().notNull(),
    text: text().notNull(),
    embeddingModel: embeddingModel(),
    embedding: embedding().notNull(),
  },
  (t) => [index().on(t.sinapseId), index().using("hnsw", t.embedding.op("vector_cosine_ops"))],
)

/** Toda alteração em sinapse gera uma versão (D20). */
export const sinapseVersions = pgTable(
  "sinapse_versions",
  {
    id: id(),
    sinapseId: uuid()
      .notNull()
      .references(() => sinapses.id, { onDelete: "cascade" }),
    title: text().notNull(),
    emoji: text(),
    summary: text().notNull(),
    content: text().notNull(),
    tags: text().array().notNull(),
    author: author().notNull(),
    reason: text(),
    sourceMessageId: uuid().references(() => messages.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.sinapseId, t.createdAt)],
)

export const sinapseLinks = pgTable(
  "sinapse_links",
  {
    id: id(),
    sinapseA: uuid()
      .notNull()
      .references(() => sinapses.id, { onDelete: "cascade" }),
    sinapseB: uuid()
      .notNull()
      .references(() => sinapses.id, { onDelete: "cascade" }),
    reason: text(),
    createdBy: author().notNull(),
    createdAt: createdAt(),
  },
  // Conexão não direcionada: guardada sempre com sinapse_a < sinapse_b (ver orderedPair),
  // o que impede duplicata invertida e auto-conexão.
  (t) => [
    uniqueIndex().on(t.sinapseA, t.sinapseB),
    check("sinapse_links_ordered_pair", sql`${t.sinapseA} < ${t.sinapseB}`),
  ],
)

/** Normaliza o par para o formato exigido por sinapse_links. */
export function orderedPair(a: string, b: string): { sinapseA: string; sinapseB: string } {
  if (a === b) throw new Error("Uma sinapse não pode se conectar a ela mesma")
  return a < b ? { sinapseA: a, sinapseB: b } : { sinapseA: b, sinapseB: a }
}

export const sinapseSources = pgTable(
  "sinapse_sources",
  {
    id: id(),
    sinapseId: uuid()
      .notNull()
      .references(() => sinapses.id, { onDelete: "cascade" }),
    conversationId: uuid().references(() => conversations.id, { onDelete: "set null" }),
    messageId: uuid().references(() => messages.id, { onDelete: "set null" }),
    fileId: uuid().references(() => files.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.sinapseId)],
)

export const sinapseSuggestions = pgTable(
  "sinapse_suggestions",
  {
    id: id(),
    sinapseId: uuid().references(() => sinapses.id, { onDelete: "cascade" }),
    kind: suggestionKind().notNull(),
    payload: jsonb().notNull(),
    reason: text(),
    status: suggestionStatus().notNull().default("pending"),
    sourceMessageId: uuid().references(() => messages.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    resolvedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.status)],
)

// ─── Arquivos ───────────────────────────────────────────────────────────────

export const files = pgTable("files", {
  id: id(),
  r2Key: text().notNull().unique(),
  name: text().notNull(),
  mime: text().notNull(),
  size: bigint({ mode: "number" }).notNull(),
  extractedText: text(),
  status: fileStatus().notNull().default("pending"),
  error: text(),
  createdAt: createdAt(),
  deletedAt: deletedAt(),
})

export const fileChunks = pgTable(
  "file_chunks",
  {
    id: id(),
    fileId: uuid()
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    idx: integer().notNull(),
    text: text().notNull(),
    embeddingModel: embeddingModel(),
    embedding: embedding().notNull(),
  },
  (t) => [index().on(t.fileId), index().using("hnsw", t.embedding.op("vector_cosine_ops"))],
)

export const messageFiles = pgTable(
  "message_files",
  {
    messageId: uuid()
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    fileId: uuid()
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.fileId] })],
)

export const generatedImages = pgTable("generated_images", {
  id: id(),
  messageId: uuid().references(() => messages.id, { onDelete: "set null" }),
  fileId: uuid()
    .notNull()
    .references(() => files.id, { onDelete: "cascade" }),
  prompt: text().notNull(),
  createdAt: createdAt(),
})

// ─── Modelos, uso e configurações ───────────────────────────────────────────

/** Catálogo próprio: /v1/models não informa preço nem descrição (D11). Preços em USD por 1M tokens. */
export const modelCatalog = pgTable("model_catalog", {
  id: text().primaryKey(),
  displayName: text(),
  inputPrice: usd(),
  cachedInputPrice: usd(),
  outputPrice: usd(),
  contextWindow: integer(),
  maxOutputTokens: integer(),
  capabilities: jsonb().$type<Record<string, boolean>>().notNull().default({}),
  recommendation: text(),
  example: text(),
  hasMetadata: boolean().notNull().default(false),
  /** Ainda aparece no /v1/models da conta. */
  available: boolean().notNull().default(true),
  openaiCreatedAt: timestamp({ withTimezone: true }),
  lastSyncedAt: timestamp({ withTimezone: true }),
  updatedAt: updatedAt(),
})

/** Todo consumo da OpenAI (chat, background, embeddings, imagem, voz). */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    source: usageSource().notNull(),
    model: text().notNull(),
    messageId: uuid().references(() => messages.id, { onDelete: "set null" }),
    tokensIn: integer().notNull().default(0),
    tokensCached: integer().notNull().default(0),
    tokensOut: integer().notNull().default(0),
    tokensReasoning: integer().notNull().default(0),
    /** Para cobranças fora de tokens (imagens, segundos de áudio). */
    units: jsonb().$type<Record<string, number>>(),
    costUsd: usd().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.createdAt), index().on(t.model)],
)

export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: updatedAt(),
})
