import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
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
  /** A OpenAI cortou a resposta (limite de saída ou filtro): dá para continuar (D69). */
  "incomplete",
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

/** Pastas são os "Projetos" da interface (D73): instruções, sinapses e arquivos próprios. */
export const folders = pgTable("folders", {
  id: id(),
  name: text().notNull(),
  position: integer().notNull().default(0),
  /** Instruções que valem para todas as conversas do projeto. */
  instructions: text().notNull().default(""),
  /** Sinapses fixadas só nas conversas deste projeto. */
  sinapseIds: uuid()
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`),
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
    /** Última mensagem já lida pelo job de consolidação de sinapses. */
    lastConsolidatedAt: timestamp({ withTimezone: true }),
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
    /** Avaliação do usuário (👍/👎) e o comentário opcional (D77). */
    rating: text().$type<"up" | "down">(),
    feedbackNote: text(),
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

/**
 * Resumo do começo de um ramo (D67): cobre da raiz até `up_to_message_id`, inclusive.
 * Vale para qualquer ramo que passe por essa mensagem; nada do histórico é apagado.
 */
export const conversationSummaries = pgTable(
  "conversation_summaries",
  {
    id: id(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    upToMessageId: uuid()
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    summary: text().notNull(),
    /** Quantas mensagens do ramo o resumo cobre. */
    messagesCount: integer().notNull(),
    model: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.conversationId, t.createdAt)],
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
  // Conexão não direcionada: guardada sempre com sinapse_a < sinapse_b
  // (ver orderedPair em modules/sinapses/links.ts), o que impede duplicata invertida e auto-conexão.
  (t) => [
    uniqueIndex().on(t.sinapseA, t.sinapseB),
    check("sinapse_links_ordered_pair", sql`${t.sinapseA} < ${t.sinapseB}`),
  ],
)

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

export const fileOrigin = pgEnum("file_origin", ["upload", "generated"])

export const files = pgTable(
  "files",
  {
    id: id(),
    r2Key: text().notNull().unique(),
    name: text().notNull(),
    mime: text().notNull(),
    size: bigint({ mode: "number" }).notNull(),
    origin: fileOrigin().notNull().default("upload"),
    /** Conversa onde o arquivo entrou (para o RAG daquela conversa). */
    conversationId: uuid().references(() => conversations.id, { onDelete: "set null" }),
    /** Arquivo do projeto: entra no RAG de todas as conversas da pasta (D73). */
    folderId: uuid().references(() => folders.id, { onDelete: "set null" }),
    extractedText: text(),
    status: fileStatus().notNull().default("pending"),
    error: text(),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index().on(t.createdAt), index().on(t.conversationId), index().on(t.folderId)],
)

/** Backups do banco enviados ao R2 (D39). */
export const backups = pgTable("backups", {
  id: id(),
  r2Key: text().notNull().unique(),
  size: bigint({ mode: "number" }),
  status: text().$type<"running" | "completed" | "failed">().notNull().default("running"),
  error: text(),
  createdAt: createdAt(),
  completedAt: timestamp({ withTimezone: true }),
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
export const modelKind = pgEnum("model_kind", [
  "chat",
  "image",
  "embedding",
  "transcription",
  "speech",
  "realtime",
  "other",
])

export const modelCatalog = pgTable("model_catalog", {
  id: text().primaryKey(),
  kind: modelKind().notNull().default("other"),
  /** Snapshot datado (ex.: gpt-5-2025-08-07): fica fora do seletor por padrão. */
  isSnapshot: boolean().notNull().default(false),
  displayName: text(),
  inputPrice: usd(),
  cachedInputPrice: usd(),
  outputPrice: usd(),
  /** Preços que não são texto por 1M tokens (áudio, imagem, por minuto, por chamada). */
  extraPrices: jsonb().$type<Record<string, number>>().notNull().default({}),
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

/** Bloqueio progressivo de login por IP (D44). No banco para sobreviver a deploys e restarts. */
export const loginThrottle = pgTable(
  "login_throttle",
  {
    /** IPv4 ou prefixo IPv6 /64 (ver lib/client-ip.ts). */
    key: text().primaryKey(),
    failures: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
    lastFailureAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.lastFailureAt)],
)

// ─── Financeiro (ver financeiro.md) ─────────────────────────────────────────

/** Dinheiro sempre em centavos inteiros (F03). Negativo = saiu, positivo = entrou. */
const cents = () => bigint({ mode: "number" })
/** Datas de lançamento são dias locais, sem fuso (F04). */
const day = () => date({ mode: "string" })

export const finAccountType = pgEnum("fin_account_type", [
  "checking",
  "credit_card",
  "cash",
  "other",
])
export const finInstitution = pgEnum("fin_institution", ["nubank", "bradesco", "other"])
export const finCategoryKind = pgEnum("fin_category_kind", ["income", "expense"])
export const finNature = pgEnum("fin_nature", ["fixed", "variable"])
/** Só `normal` entra em ganhos e gastos (F06). */
export const finTxClass = pgEnum("fin_tx_class", ["normal", "transfer", "adjustment"])
/** F11 e F16: `planned` = prevista; `review` = espera você; `auto` = IA; `confirmed` = você ou regra. */
export const finTxStatus = pgEnum("fin_tx_status", ["planned", "review", "auto", "confirmed"])
export const finCategorySource = pgEnum("fin_category_source", ["user", "rule", "ai"])
export const finRuleMatch = pgEnum("fin_rule_match", ["contains", "equals", "regex"])
/** F12/F13: `ask` = sempre perguntar (a IA não chuta). */
export const finRuleAction = pgEnum("fin_rule_action", ["categorize", "ask", "transfer"])
export const finImportStatus = pgEnum("fin_import_status", ["done", "failed", "undone"])
export const finDirection = pgEnum("fin_direction", ["in", "out"])
export const finAssetType = pgEnum("fin_asset_type", [
  "vehicle",
  "real_estate",
  "investment",
  "other",
])
export const finSuggestionStatus = pgEnum("fin_suggestion_status", [
  "pending",
  "accepted",
  "dismissed",
])

export const finAccounts = pgTable("fin_accounts", {
  id: id(),
  name: text().notNull(),
  type: finAccountType().notNull(),
  institution: finInstitution().notNull().default("other"),
  /** Rótulo livre de titular (F02). */
  holder: text(),
  /** Só cartão: dias padrão para criar faturas (F05). */
  closingDay: integer(),
  dueDay: integer(),
  /** Saldo no fim do dia `openingDate` (F18). Calculado sozinho pelo primeiro extrato com saldo. */
  openingBalance: cents().notNull().default(0),
  openingDate: day(),
  /** Último saldo informado pelo banco, para conferir com o calculado. */
  bankBalance: cents(),
  bankBalanceDate: day(),
  /**
   * Conta sem extrato, só de passagem (ex.: o salário entra e vai para o cartão). Fica fora do
   * patrimônio, das previsões e dos extratos; previstas nela se confirmam sozinhas na data.
   */
  trackBalance: boolean().notNull().default(true),
  position: integer().notNull().default(0),
  archivedAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const finCategories = pgTable(
  "fin_categories",
  {
    id: id(),
    name: text().notNull(),
    kind: finCategoryKind().notNull(),
    /** Tipo padrão das transações desta categoria (F14). */
    nature: finNature().notNull().default("variable"),
    position: integer().notNull().default(0),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("fin_categories_name_unique")
      .on(sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
  ],
)

export const finInvoices = pgTable(
  "fin_invoices",
  {
    id: id(),
    accountId: uuid()
      .notNull()
      .references(() => finAccounts.id, { onDelete: "cascade" }),
    /** Dia 1 do mês de vencimento. */
    referenceMonth: day().notNull(),
    closingDate: day().notNull(),
    bestPurchaseDate: day().notNull(),
    dueDate: day().notNull(),
    /** Total informado pelo banco (saldo do OFX da fatura). */
    statementTotal: cents(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.accountId, t.referenceMonth)],
)

export const finImportBatches = pgTable(
  "fin_import_batches",
  {
    id: id(),
    accountId: uuid()
      .notNull()
      .references(() => finAccounts.id, { onDelete: "cascade" }),
    fileName: text().notNull(),
    format: text().notNull(),
    invoiceId: uuid().references(() => finInvoices.id, { onDelete: "set null" }),
    /** Dias que o arquivo cobre (F41/F61). */
    periodStart: day(),
    periodEnd: day(),
    counts: jsonb().$type<Record<string, number>>().notNull().default({}),
    /** Saldo do banco × calculado no último dia do arquivo, quando o arquivo traz saldo. */
    balanceCheck: jsonb().$type<{ date: string; bank: number; computed: number }>(),
    status: finImportStatus().notNull().default("done"),
    createdAt: createdAt(),
    undoneAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.accountId, t.createdAt)],
)

export const finRecurring = pgTable("fin_recurring", {
  id: id(),
  name: text().notNull(),
  direction: finDirection().notNull(),
  categoryId: uuid().references(() => finCategories.id, { onDelete: "set null" }),
  accountId: uuid()
    .notNull()
    .references(() => finAccounts.id, { onDelete: "cascade" }),
  /** Valor esperado, sempre positivo. */
  expectedAmount: cents().notNull().default(0),
  tolerancePct: integer().notNull().default(15),
  dayOfMonth: integer().notNull(),
  /** Trecho do texto do banco que identifica o lançamento real (opcional). */
  matchPattern: text(),
  startsOn: day().notNull(),
  endsOn: day(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const finRules = pgTable("fin_rules", {
  id: id(),
  matchType: finRuleMatch().notNull().default("contains"),
  /** Comparado com a descrição original normalizada (sem acento, maiúsculas). */
  pattern: text().notNull(),
  accountId: uuid().references(() => finAccounts.id, { onDelete: "cascade" }),
  minAmount: cents(),
  maxAmount: cents(),
  /** 1 = só entradas, -1 = só saídas. */
  sign: integer(),
  action: finRuleAction().notNull().default("categorize"),
  categoryId: uuid().references(() => finCategories.id, { onDelete: "cascade" }),
  renameTo: text(),
  nature: finNature(),
  priority: integer().notNull().default(0),
  enabled: boolean().notNull().default(true),
  hits: integer().notNull().default(0),
  lastHitAt: timestamp({ withTimezone: true }),
  createdBy: author().notNull().default("user"),
  createdAt: createdAt(),
})

export const finTransactions = pgTable(
  "fin_transactions",
  {
    id: id(),
    accountId: uuid()
      .notNull()
      .references(() => finAccounts.id, { onDelete: "cascade" }),
    invoiceId: uuid().references(() => finInvoices.id, { onDelete: "set null" }),
    date: day().notNull(),
    amount: cents().notNull(),
    class: finTxClass().notNull().default("normal"),
    /** Editável; a original do banco nunca muda (F15). */
    description: text().notNull(),
    originalDescription: text(),
    /** Chave do estabelecimento (descrição original normalizada, sem números). */
    merchant: text(),
    categoryId: uuid().references(() => finCategories.id, { onDelete: "set null" }),
    /** Sobrescreve o tipo da categoria só nesta transação. */
    nature: finNature(),
    status: finTxStatus().notNull().default("confirmed"),
    categorySource: finCategorySource(),
    ruleId: uuid().references(() => finRules.id, { onDelete: "set null" }),
    aiConfidence: real(),
    aiQuestion: text(),
    /** Categorias sugeridas (ids), da IA ou do histórico. */
    aiSuggestions: uuid().array(),
    /** IA já olhou esta transação (não manda de novo). */
    aiTriedAt: timestamp({ withTimezone: true }),
    transferGroupId: uuid(),
    installmentGroup: text(),
    installmentNumber: integer(),
    installmentTotal: integer(),
    recurringId: uuid().references(() => finRecurring.id, { onDelete: "set null" }),
    /** Dia 1 do mês da ocorrência do recorrente (F19). */
    recurringPeriod: day(),
    /** Data antes do primeiro adiamento (F29). */
    deferredFrom: day(),
    deferralReason: text(),
    /** Lançada à mão e ainda não juntada com o extrato (F34). */
    manual: boolean().notNull().default(false),
    importBatchId: uuid().references(() => finImportBatches.id, { onDelete: "set null" }),
    externalId: text(),
    /** Identidade do lançamento no banco, única por conta (F08). */
    fingerprint: text(),
    notes: text(),
    createdBy: author().notNull().default("user"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index().on(t.date),
    index().on(t.accountId, t.date),
    index().on(t.categoryId, t.date),
    index().on(t.merchant),
    index()
      .on(t.status)
      .where(sql`${t.status} = 'review'`),
    uniqueIndex()
      .on(t.accountId, t.fingerprint)
      .where(sql`${t.fingerprint} is not null and ${t.deletedAt} is null`),
    uniqueIndex()
      .on(t.recurringId, t.recurringPeriod)
      .where(sql`${t.recurringId} is not null and ${t.deletedAt} is null`),
  ],
)

/** Divisão de uma transação em várias categorias (F21/F36). A soma bate com o valor da transação. */
export const finSplits = pgTable(
  "fin_splits",
  {
    transactionId: uuid()
      .notNull()
      .references(() => finTransactions.id, { onDelete: "cascade" }),
    idx: integer().notNull(),
    categoryId: uuid().references(() => finCategories.id, { onDelete: "set null" }),
    amount: cents().notNull(),
  },
  (t) => [primaryKey({ columns: [t.transactionId, t.idx] })],
)

export const finRuleSuggestions = pgTable(
  "fin_rule_suggestions",
  {
    id: id(),
    pattern: text().notNull(),
    categoryId: uuid()
      .notNull()
      .references(() => finCategories.id, { onDelete: "cascade" }),
    evidence: integer().notNull().default(0),
    status: finSuggestionStatus().notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.pattern)],
)

export const finAssets = pgTable("fin_assets", {
  id: id(),
  name: text().notNull(),
  type: finAssetType().notNull().default("other"),
  archivedAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
})

/** Valor de um bem numa data (F20). O valor atual é a avaliação mais recente. */
export const finAssetValuations = pgTable(
  "fin_asset_valuations",
  {
    id: id(),
    assetId: uuid()
      .notNull()
      .references(() => finAssets.id, { onDelete: "cascade" }),
    date: day().notNull(),
    value: cents().notNull(),
    source: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.assetId, t.date)],
)

/** Toda mudança em transação, para desfazer uma operação inteira (F22). */
export const finChanges = pgTable(
  "fin_changes",
  {
    id: id(),
    operationId: uuid().notNull(),
    transactionId: uuid().notNull(),
    /** null = a transação não existia antes da operação. */
    before: jsonb().$type<Record<string, unknown>>(),
    author: author().notNull().default("user"),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.operationId)],
)

/**
 * Contas sem data (F76): gastos que vão acontecer, mas sem quando (ex.: arrumar o para-choque).
 * Não entram no mês até serem agendadas (viram uma transação prevista) ou pagas.
 */
export const finPending = pgTable(
  "fin_pending",
  {
    id: id(),
    name: text().notNull(),
    /** Valor estimado, positivo; null = ainda não sei. */
    estimate: cents(),
    categoryId: uuid().references(() => finCategories.id, { onDelete: "set null" }),
    notes: text(),
    /** Transação criada ao agendar ou pagar; a conta sai da lista. */
    transactionId: uuid().references(() => finTransactions.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    closedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.closedAt)],
)

/** Dívidas (F84): o que alguém emprestou para vocês; pagamentos livres abatem o saldo. */
export const finDebts = pgTable(
  "fin_debts",
  {
    id: id(),
    /** De quem ou do quê (ex.: "Empréstimo da mãe"). */
    name: text().notNull(),
    /** Quanto foi emprestado, positivo. */
    amount: cents().notNull(),
    startedOn: day().notNull(),
    notes: text(),
    createdAt: createdAt(),
    /** Tirada da lista; quitada é quando os pagamentos cobrem o valor. */
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.archivedAt)],
)

export const finDebtPayments = pgTable(
  "fin_debt_payments",
  {
    id: id(),
    debtId: uuid()
      .notNull()
      .references(() => finDebts.id, { onDelete: "cascade" }),
    /** Saída criada ao pagar; se for apagada no fluxo, o pagamento deixa de contar. */
    transactionId: uuid().references(() => finTransactions.id, { onDelete: "set null" }),
    date: day().notNull(),
    amount: cents().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.debtId)],
)
