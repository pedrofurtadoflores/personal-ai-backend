import { and, asc, desc, eq, gte, isNull } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import {
  finAccounts,
  finAssetValuations,
  finAssets,
  finCategories,
  finInvoices,
  finRecurring,
  finRuleSuggestions,
  finRules,
  finTransactions,
} from "../../db/schema.js"
import { HttpError, notFound, withErrors } from "../../lib/http.js"
import { enqueue } from "../../lib/jobs.js"
import "./categorize.js"
import { addDays, monthOf, today } from "./dates.js"
import { importStatement, undoImport } from "./import.js"
import { debtRoutes } from "./debts.js"
import { pendingRoutes } from "./pending.js"
import { parseQuick } from "./quick.js"
import { isValidPattern, ruleMatches } from "./rules.js"
import {
  accountSchema,
  categorySchema,
  centsSchema,
  dayParam,
  idParams,
  importResultSchema,
  invoiceSchema,
  monthParam,
  netWorthSchema,
  operationSchema,
  overviewSchema,
  planningSchema,
  recurringSchema,
  reviewSchema,
  ruleSchema,
  ruleSuggestionSchema,
  statementsSchema,
  txSchema,
} from "./schemas.js"
import {
  acceptRuleSuggestion,
  createManualTransaction,
  deferTransaction,
  deleteTransaction,
  endRecurring,
  ensureOccurrences,
  financeSettingsSchema,
  getFinanceSettings,
  loadRange,
  payTransaction,
  resolveReview,
  splitTransaction,
  syncRecurring,
  undeferTransaction,
  undoOperation,
  updateFinanceSettings,
  updateTransaction,
} from "./service.js"
import { netWorth, overview, planning, reviewQueue, statements, txDto } from "./views.js"

const MAX_STATEMENT_BYTES = 2 * 1024 * 1024
const tags = ["finance"]
const ok = z.object({ ok: z.literal(true) })

/** Categorias sugeridas no primeiro acesso (seção 6), um nível só (F46). */
const DEFAULT_CATEGORIES: {
  name: string
  kind: "income" | "expense"
  nature: "fixed" | "variable"
}[] = [
  { name: "Moradia", kind: "expense", nature: "fixed" },
  { name: "Alimentação", kind: "expense", nature: "variable" },
  { name: "Transporte", kind: "expense", nature: "variable" },
  { name: "Saúde", kind: "expense", nature: "variable" },
  { name: "Assinaturas", kind: "expense", nature: "fixed" },
  { name: "Hobbies e lazer", kind: "expense", nature: "variable" },
  { name: "Compras", kind: "expense", nature: "variable" },
  { name: "Educação", kind: "expense", nature: "variable" },
  { name: "Pets", kind: "expense", nature: "variable" },
  { name: "Presentes", kind: "expense", nature: "variable" },
  { name: "Viagens", kind: "expense", nature: "variable" },
  { name: "Impostos e taxas", kind: "expense", nature: "fixed" },
  { name: "Dívidas", kind: "expense", nature: "fixed" },
  { name: "Outros", kind: "expense", nature: "variable" },
  { name: "Salários", kind: "income", nature: "fixed" },
  { name: "Extras", kind: "income", nature: "variable" },
  { name: "Rendimentos", kind: "income", nature: "variable" },
  { name: "Reembolsos", kind: "income", nature: "variable" },
  { name: "Outros ganhos", kind: "income", nature: "variable" },
]

const accountInput = z.object({
  name: z.string().trim().min(1).max(60),
  type: z.enum(["checking", "credit_card", "cash", "other"]),
  institution: z.enum(["nubank", "bradesco", "other"]).default("other"),
  holder: z.string().trim().max(40).nullable().optional(),
  closingDay: z.number().int().min(1).max(31).nullable().optional(),
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
  openingBalance: centsSchema.optional(),
  openingDate: dayParam.nullable().optional(),
  trackBalance: z.boolean().optional(),
})

const recurringInput = z.object({
  name: z.string().trim().min(1).max(80),
  direction: z.enum(["in", "out"]),
  dayOfMonth: z.number().int().min(1).max(31),
  expectedAmount: centsSchema.min(0),
  accountId: z.uuid(),
  categoryId: z.uuid().nullable().optional(),
  matchPattern: z.string().trim().max(80).nullable().optional(),
  tolerancePct: z.number().int().min(0).max(100).optional(),
  /** Primeiro mês (padrão: o atual) e último dia em que vale (ex.: empréstimo até fevereiro). */
  startsOn: dayParam.optional(),
  endsOn: dayParam.nullable().optional(),
})

const ruleInput = z.object({
  matchType: z.enum(["contains", "equals", "regex"]).default("contains"),
  pattern: z.string().trim().min(1).max(200),
  accountId: z.uuid().nullable().optional(),
  minAmount: centsSchema.min(0).nullable().optional(),
  maxAmount: centsSchema.min(0).nullable().optional(),
  sign: z
    .union([z.literal(1), z.literal(-1)])
    .nullable()
    .optional(),
  action: z.enum(["categorize", "ask", "transfer"]).default("categorize"),
  categoryId: z.uuid().nullable().optional(),
  renameTo: z.string().trim().max(80).nullable().optional(),
  nature: z.enum(["fixed", "variable"]).nullable().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  enabled: z.boolean().optional(),
})

export const financeRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(pendingRoutes)
  await app.register(debtRoutes)

  // ─── Contas ───────────────────────────────────────────────────────────────

  app.get(
    "/finance/accounts",
    {
      schema: {
        tags,
        summary: "Contas e cartões",
        response: withErrors({ 200: z.object({ accounts: z.array(accountSchema) }) }),
      },
    },
    async () => ({
      accounts: await db
        .select()
        .from(finAccounts)
        .orderBy(asc(finAccounts.position), asc(finAccounts.createdAt)),
    }),
  )

  app.post(
    "/finance/accounts",
    {
      schema: {
        tags,
        summary: "Nova conta ou cartão",
        body: accountInput,
        response: withErrors({ 201: accountSchema }),
      },
    },
    async (request, reply) => {
      const [row] = await db.insert(finAccounts).values(request.body).returning()
      return reply.code(201).send(row!)
    },
  )

  app.patch(
    "/finance/accounts/:id",
    {
      schema: {
        tags,
        summary: "Alterar conta (nome, ciclo do cartão, saldo inicial, arquivar)",
        params: idParams,
        body: accountInput.partial().extend({ archived: z.boolean().optional() }),
        response: withErrors({
          200: accountSchema,
          404: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => {
      const { archived, ...rest } = request.body
      const [row] = await db
        .update(finAccounts)
        .set({
          ...rest,
          ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}),
        })
        .where(eq(finAccounts.id, request.params.id))
        .returning()
      if (!row) throw notFound("Conta")
      return row
    },
  )

  // ─── Categorias ───────────────────────────────────────────────────────────

  app.get(
    "/finance/categories",
    {
      schema: {
        tags,
        summary: "Categorias",
        response: withErrors({ 200: z.object({ categories: z.array(categorySchema) }) }),
      },
    },
    async () => ({
      categories: await db
        .select()
        .from(finCategories)
        .orderBy(asc(finCategories.kind), asc(finCategories.position), asc(finCategories.name)),
    }),
  )

  app.post(
    "/finance/categories",
    {
      schema: {
        tags,
        summary: "Nova categoria",
        body: z.object({
          name: z.string().trim().min(1).max(40),
          kind: z.enum(["income", "expense"]),
          nature: z.enum(["fixed", "variable"]).default("variable"),
        }),
        response: withErrors({
          201: categorySchema,
          409: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request, reply) => {
      const [row] = await db
        .insert(finCategories)
        .values(request.body)
        .onConflictDoNothing()
        .returning()
      if (!row)
        throw new HttpError(409, "category_exists", "Já existe uma categoria com esse nome.")
      return reply.code(201).send(row)
    },
  )

  app.post(
    "/finance/categories/defaults",
    {
      schema: {
        tags,
        summary: "Criar as categorias sugeridas (as que você escolher; as existentes ficam)",
        body: z.object({ names: z.array(z.string()).optional() }),
        response: withErrors({ 200: z.object({ categories: z.array(categorySchema) }) }),
      },
    },
    async (request) => {
      const wanted = DEFAULT_CATEGORIES.filter(
        (c) => !request.body.names || request.body.names.includes(c.name),
      )
      for (const [position, c] of wanted.entries()) {
        await db
          .insert(finCategories)
          .values({ ...c, position })
          .onConflictDoNothing()
      }
      return {
        categories: await db
          .select()
          .from(finCategories)
          .orderBy(asc(finCategories.kind), asc(finCategories.position)),
      }
    },
  )

  app.patch(
    "/finance/categories/:id",
    {
      schema: {
        tags,
        summary: "Renomear, mudar o tipo padrão, reordenar ou arquivar",
        params: idParams,
        body: z.object({
          name: z.string().trim().min(1).max(40).optional(),
          nature: z.enum(["fixed", "variable"]).optional(),
          position: z.number().int().optional(),
          archived: z.boolean().optional(),
        }),
        response: withErrors({
          200: categorySchema,
          404: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => {
      const { archived, ...rest } = request.body
      const [row] = await db
        .update(finCategories)
        .set({
          ...rest,
          ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}),
        })
        .where(eq(finCategories.id, request.params.id))
        .returning()
      if (!row) throw notFound("Categoria")
      return row
    },
  )

  // ─── Configurações e visões ───────────────────────────────────────────────

  app.get(
    "/finance/settings",
    {
      schema: {
        tags,
        summary: "Meta de guardar e limiar da IA",
        response: withErrors({ 200: financeSettingsSchema }),
      },
    },
    async () => getFinanceSettings(),
  )

  app.patch(
    "/finance/settings",
    {
      schema: {
        tags,
        summary: "Alterar meta de guardar e limiar da IA",
        body: financeSettingsSchema.partial(),
        response: withErrors({ 200: financeSettingsSchema }),
      },
    },
    async (request) => updateFinanceSettings(request.body),
  )

  app.get(
    "/finance/overview",
    {
      schema: {
        tags,
        summary: "Visão geral do mês: resumo, categorias, fluxo e alertas",
        querystring: z.object({ month: monthParam.optional() }),
        response: withErrors({ 200: overviewSchema }),
      },
    },
    async (request) => overview(request.query.month ?? monthOf(today())),
  )

  app.get(
    "/finance/planning",
    {
      schema: {
        tags,
        summary: "Contas fixas, parcelas e compromissos dos próximos meses",
        querystring: z.object({ month: monthParam.optional() }),
        response: withErrors({ 200: planningSchema }),
      },
    },
    async (request) => planning(request.query.month ?? monthOf(today())),
  )

  app.get(
    "/finance/net-worth",
    {
      schema: {
        tags,
        summary: "Patrimônio: o que você tem, o que deve e a evolução",
        response: withErrors({ 200: netWorthSchema }),
      },
    },
    async () => netWorth(),
  )

  app.get(
    "/finance/statements",
    {
      schema: {
        tags,
        summary: "Extratos por mês e conta (situação, cobertura e arquivos)",
        querystring: z.object({ monthsBack: z.coerce.number().int().min(0).max(24).default(3) }),
        response: withErrors({ 200: statementsSchema }),
      },
    },
    async (request) => statements(request.query.monthsBack),
  )

  // ─── Transações ───────────────────────────────────────────────────────────

  const txPatch = z.object({
    date: dayParam.optional(),
    description: z.string().max(200).optional(),
    categoryId: z.uuid().nullable().optional(),
    accountId: z.uuid().optional(),
    amount: centsSchema.optional(),
    nature: z.enum(["fixed", "variable"]).nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
    class: z.enum(["normal", "transfer"]).optional(),
  })

  app.get(
    "/finance/transactions",
    {
      schema: {
        tags,
        summary: "Transações de um período (inclusive transferências)",
        querystring: z.object({ from: dayParam, to: dayParam, accountId: z.uuid().optional() }),
        response: withErrors({ 200: z.object({ transactions: z.array(txSchema) }) }),
      },
    },
    async (request) => {
      const { from, to, accountId } = request.query
      const accounts = new Map((await db.select().from(finAccounts)).map((a) => [a.id, a]))
      const rows = (await loadRange(from, to)).filter(
        (t) => !accountId || t.accountId === accountId,
      )
      const now = today()
      return {
        transactions: rows.map((t) => txDto(t, { month: t.month, today: now, accounts })),
      }
    },
  )

  app.post(
    "/finance/transactions",
    {
      schema: {
        tags,
        summary: "Lançamento manual (F34: junta com o extrato quando ele chegar)",
        body: z.object({
          accountId: z.uuid(),
          date: dayParam,
          amount: centsSchema,
          description: z.string().max(200),
          categoryId: z.uuid().nullable().optional(),
          notes: z.string().max(500).nullable().optional(),
        }),
        response: withErrors({ 201: z.object({ id: z.string(), operationId: z.string() }) }),
      },
    },
    async (request, reply) => {
      const { transaction, operationId } = await createManualTransaction(request.body)
      return reply.code(201).send({ id: transaction.id, operationId })
    },
  )

  app.patch(
    "/finance/transactions/:id",
    {
      schema: {
        tags,
        summary:
          "Editar célula: data, descrição, categoria, tipo, notas (valor/conta só em manuais e previstas)",
        params: idParams,
        body: txPatch,
        response: withErrors({
          200: z.object({ operationId: z.string(), suggestion: ruleSuggestionSchema.nullable() }),
          404: z.object({ error: z.string(), message: z.string().optional() }),
          409: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => updateTransaction(request.params.id, request.body),
  )

  app.delete(
    "/finance/transactions/:id",
    {
      schema: {
        tags,
        summary: "Excluir lançamento manual ou previsto",
        params: idParams,
        response: withErrors({
          200: operationSchema,
          404: z.object({ error: z.string(), message: z.string().optional() }),
          409: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => deleteTransaction(request.params.id),
  )

  app.put(
    "/finance/transactions/:id/splits",
    {
      schema: {
        tags,
        summary: "Dividir em categorias (lista vazia desfaz a divisão)",
        params: idParams,
        body: z.object({
          parts: z
            .array(z.object({ categoryId: z.uuid().nullable(), amount: centsSchema }))
            .max(10),
        }),
        response: withErrors({
          200: operationSchema,
          404: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => splitTransaction(request.params.id, request.body.parts),
  )

  app.post(
    "/finance/transactions/:id/defer",
    {
      schema: {
        tags,
        summary: "Adiar só esta ocorrência (F29)",
        params: idParams,
        body: z.object({ date: dayParam, reason: z.string().max(200).nullable().optional() }),
        response: withErrors({
          200: operationSchema,
          404: z.object({ error: z.string(), message: z.string().optional() }),
          409: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => deferTransaction(request.params.id, request.body.date, request.body.reason),
  )

  app.post(
    "/finance/transactions/:id/undefer",
    {
      schema: {
        tags,
        summary: "Desfazer adiamento",
        params: idParams,
        response: withErrors({
          200: operationSchema,
          404: z.object({ error: z.string(), message: z.string().optional() }),
          409: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => undeferTransaction(request.params.id),
  )

  app.post(
    "/finance/transactions/:id/pay",
    {
      schema: {
        tags,
        summary: "Já paguei / Já recebi (F57)",
        params: idParams,
        body: z.object({
          date: dayParam,
          amount: centsSchema.min(0).optional(),
          accountId: z.uuid().optional(),
        }),
        response: withErrors({
          200: operationSchema,
          404: z.object({ error: z.string(), message: z.string().optional() }),
          409: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => payTransaction(request.params.id, request.body),
  )

  app.post(
    "/finance/operations/:id/undo",
    {
      schema: {
        tags,
        summary: "Desfazer uma operação inteira (F22)",
        params: idParams,
        response: withErrors({
          200: ok,
          404: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => {
      await undoOperation(request.params.id)
      return { ok: true as const }
    },
  )

  app.post(
    "/finance/quick-parse",
    {
      schema: {
        tags,
        summary: 'Lançamento rápido: entende "50 feira bradesco ontem" (F35)',
        body: z.object({ text: z.string().trim().min(1).max(200) }),
        response: withErrors({
          200: z.object({
            description: z.string(),
            amount: centsSchema.nullable(),
            direction: z.enum(["in", "out"]),
            date: z.string(),
            accountId: z.string().nullable(),
            categoryId: z.string().nullable(),
          }),
        }),
      },
    },
    async (request) => {
      const [accounts, categories] = await Promise.all([
        db.select().from(finAccounts).where(isNull(finAccounts.archivedAt)),
        db.select().from(finCategories).where(isNull(finCategories.archivedAt)),
      ])
      return parseQuick(request.body.text, { today: today(), accounts, categories })
    },
  )

  // ─── Revisar ──────────────────────────────────────────────────────────────

  app.get(
    "/finance/review",
    {
      schema: {
        tags,
        summary: "Fila Revisar e sugestões de regra",
        response: withErrors({ 200: reviewSchema }),
      },
    },
    async () => reviewQueue(),
  )

  app.post(
    "/finance/review/:id",
    {
      schema: {
        tags,
        summary: "Resolver um item da fila",
        params: idParams,
        body: z.object({
          categoryId: z.uuid(),
          applyToSame: z.boolean().default(false),
          description: z.string().max(200).optional(),
        }),
        response: withErrors({
          200: z.object({
            operationId: z.string(),
            resolved: z.number(),
            suggestion: ruleSuggestionSchema.nullable(),
          }),
          404: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => resolveReview(request.params.id, request.body),
  )

  app.post(
    "/finance/rule-suggestions/:id/accept",
    {
      schema: {
        tags,
        summary: "Aceitar sugestão: cria a regra",
        params: idParams,
        response: withErrors({
          200: ruleSchema,
          404: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => acceptRuleSuggestion(request.params.id),
  )

  app.post(
    "/finance/rule-suggestions/:id/dismiss",
    {
      schema: {
        tags,
        summary: "Recusar sugestão (não volta)",
        params: idParams,
        response: withErrors({ 200: ok }),
      },
    },
    async (request) => {
      await db
        .update(finRuleSuggestions)
        .set({ status: "dismissed" })
        .where(eq(finRuleSuggestions.id, request.params.id))
      return { ok: true as const }
    },
  )

  app.post(
    "/finance/categorize",
    {
      schema: {
        tags,
        summary: "Pedir à IA para categorizar as pendentes agora",
        response: withErrors({ 202: z.object({ queued: z.literal(true) }) }),
      },
    },
    async (_request, reply) => {
      await enqueue("finance.categorize", {}, { singleton: true, key: "finance.categorize" })
      return reply.code(202).send({ queued: true as const })
    },
  )

  // ─── Importação ───────────────────────────────────────────────────────────

  app.post(
    "/finance/imports",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags,
        summary: "Importar extrato (multipart, campo `file`; OFX ou CSV)",
        consumes: ["multipart/form-data"],
        querystring: z.object({ accountId: z.uuid().optional(), since: dayParam.optional() }),
        response: withErrors({
          201: importResultSchema,
          413: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request, reply) => {
      const part = await request.file({ limits: { fileSize: MAX_STATEMENT_BYTES } })
      if (!part) throw new HttpError(400, "bad_request", "Envie o extrato no campo `file`.")
      const buffer = await part.toBuffer()
      if (part.file.truncated)
        throw new HttpError(413, "payload_too_large", "O extrato passa de 2 MB.")
      const batch = await importStatement({
        buffer,
        fileName: part.filename || "extrato",
        accountId: request.query.accountId,
        since: request.query.since,
      })
      return reply.code(201).send(batch)
    },
  )

  app.post(
    "/finance/imports/:id/undo",
    {
      schema: {
        tags,
        summary: "Desfazer importação (F09)",
        params: idParams,
        response: withErrors({
          200: ok,
          404: z.object({ error: z.string(), message: z.string().optional() }),
          409: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => {
      await undoImport(request.params.id)
      return { ok: true as const }
    },
  )

  app.patch(
    "/finance/invoices/:id",
    {
      schema: {
        tags,
        summary: "Datas de uma fatura (fechamento, melhor data de compra, vencimento)",
        params: idParams,
        body: z.object({
          closingDate: dayParam.optional(),
          bestPurchaseDate: dayParam.optional(),
          dueDate: dayParam.optional(),
        }),
        response: withErrors({
          200: invoiceSchema,
          404: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => {
      const [row] = await db
        .update(finInvoices)
        .set(request.body)
        .where(eq(finInvoices.id, request.params.id))
        .returning()
      if (!row) throw notFound("Fatura")
      return row
    },
  )

  // ─── Regras ───────────────────────────────────────────────────────────────

  app.get(
    "/finance/rules",
    {
      schema: {
        tags,
        summary: "Regras",
        response: withErrors({ 200: z.object({ rules: z.array(ruleSchema) }) }),
      },
    },
    async () => ({
      rules: await db
        .select()
        .from(finRules)
        .orderBy(desc(finRules.priority), asc(finRules.createdAt)),
    }),
  )

  const checkRule = (body: Partial<z.infer<typeof ruleInput>>) => {
    if (body.pattern !== undefined && !isValidPattern(body.matchType ?? "contains", body.pattern)) {
      throw new HttpError(400, "invalid_pattern", "Padrão inválido.")
    }
    if (body.action === "categorize" && body.categoryId === null) {
      throw new HttpError(400, "category_required", "Escolha a categoria da regra.")
    }
  }

  app.post(
    "/finance/rules",
    {
      schema: {
        tags,
        summary: "Nova regra",
        body: ruleInput,
        response: withErrors({ 201: ruleSchema }),
      },
    },
    async (request, reply) => {
      checkRule(request.body)
      if (request.body.action === "categorize" && !request.body.categoryId) {
        throw new HttpError(400, "category_required", "Escolha a categoria da regra.")
      }
      const [row] = await db.insert(finRules).values(request.body).returning()
      return reply.code(201).send(row!)
    },
  )

  app.patch(
    "/finance/rules/:id",
    {
      schema: {
        tags,
        summary: "Alterar regra",
        params: idParams,
        body: ruleInput.partial(),
        response: withErrors({
          200: ruleSchema,
          404: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => {
      checkRule(request.body)
      const [row] = await db
        .update(finRules)
        .set(request.body)
        .where(eq(finRules.id, request.params.id))
        .returning()
      if (!row) throw notFound("Regra")
      return row
    },
  )

  app.delete(
    "/finance/rules/:id",
    {
      schema: {
        tags,
        summary: "Apagar regra",
        params: idParams,
        response: withErrors({ 200: ok }),
      },
    },
    async (request) => {
      await db.delete(finRules).where(eq(finRules.id, request.params.id))
      return { ok: true as const }
    },
  )

  app.post(
    "/finance/rules/test",
    {
      schema: {
        tags,
        summary: "Testar um padrão nos lançamentos dos últimos 90 dias",
        body: z.object({
          matchType: z.enum(["contains", "equals", "regex"]).default("contains"),
          pattern: z.string().trim().min(1).max(200),
        }),
        response: withErrors({
          200: z.object({
            count: z.number(),
            sample: z.array(
              txSchema.pick({ id: true, date: true, amount: true, description: true }),
            ),
          }),
        }),
      },
    },
    async (request) => {
      if (!isValidPattern(request.body.matchType, request.body.pattern))
        throw new HttpError(400, "invalid_pattern", "Padrão inválido.")
      const rule = {
        ...request.body,
        accountId: null,
        minAmount: null,
        maxAmount: null,
        sign: null,
        enabled: true,
      }
      const rows = await db
        .select()
        .from(finTransactions)
        .where(
          and(isNull(finTransactions.deletedAt), gte(finTransactions.date, addDays(today(), -90))),
        )
      const hits = rows.filter((t) =>
        ruleMatches(rule, {
          description: t.originalDescription ?? t.description,
          accountId: t.accountId,
          amount: t.amount,
        }),
      )
      return {
        count: hits.length,
        sample: hits
          .slice(0, 5)
          .map(({ id, date, amount, description }) => ({ id, date, amount, description })),
      }
    },
  )

  // ─── Recorrentes ──────────────────────────────────────────────────────────

  app.post(
    "/finance/recurring",
    {
      schema: {
        tags,
        summary: "Nova conta fixa ou entrada fixa",
        body: recurringInput,
        response: withErrors({ 201: recurringSchema }),
      },
    },
    async (request, reply) => {
      const startsOn = `${monthOf(request.body.startsOn ?? today())}-01`
      const [row] = await db
        .insert(finRecurring)
        .values({ ...request.body, startsOn })
        .returning()
      await ensureOccurrences(monthOf(today()), monthOf(addDays(today(), 100)))
      return reply.code(201).send(row!)
    },
  )

  app.patch(
    "/finance/recurring/:id",
    {
      schema: {
        tags,
        summary: "Alterar cadastro (muda as ocorrências ainda previstas, F64)",
        params: idParams,
        body: recurringInput.partial(),
        response: withErrors({
          200: recurringSchema,
          404: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => {
      const [row] = await db
        .update(finRecurring)
        .set(request.body)
        .where(eq(finRecurring.id, request.params.id))
        .returning()
      if (!row) throw notFound("Recorrente")
      await syncRecurring(row)
      return row
    },
  )

  app.delete(
    "/finance/recurring/:id",
    {
      schema: {
        tags,
        summary: "Encerrar (some dos próximos meses)",
        params: idParams,
        response: withErrors({
          200: ok,
          404: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => {
      await endRecurring(request.params.id)
      return { ok: true as const }
    },
  )

  // ─── Bens ─────────────────────────────────────────────────────────────────

  app.post(
    "/finance/assets",
    {
      schema: {
        tags,
        summary: "Novo bem (carro, imóvel, investimento)",
        body: z.object({
          name: z.string().trim().min(1).max(60),
          type: z.enum(["vehicle", "real_estate", "investment", "other"]).default("other"),
          value: centsSchema.min(0),
          date: dayParam.optional(),
          source: z.string().trim().max(60).nullable().optional(),
        }),
        response: withErrors({ 201: z.object({ id: z.string() }) }),
      },
    },
    async (request, reply) => {
      const [asset] = await db
        .insert(finAssets)
        .values({ name: request.body.name, type: request.body.type })
        .returning()
      await db.insert(finAssetValuations).values({
        assetId: asset!.id,
        date: request.body.date ?? today(),
        value: request.body.value,
        source: request.body.source ?? null,
      })
      return reply.code(201).send({ id: asset!.id })
    },
  )

  app.patch(
    "/finance/assets/:id",
    {
      schema: {
        tags,
        summary: "Renomear ou registrar novo valor (vira uma avaliação datada)",
        params: idParams,
        body: z.object({
          name: z.string().trim().min(1).max(60).optional(),
          value: centsSchema.min(0).optional(),
          date: dayParam.optional(),
          source: z.string().trim().max(60).nullable().optional(),
          archived: z.boolean().optional(),
        }),
        response: withErrors({
          200: ok,
          404: z.object({ error: z.string(), message: z.string().optional() }),
        }),
      },
    },
    async (request) => {
      const { name, value, date, source, archived } = request.body
      const [asset] = await db
        .update(finAssets)
        .set({
          ...(name ? { name } : {}),
          ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}),
        })
        .where(eq(finAssets.id, request.params.id))
        .returning()
      if (!asset) throw notFound("Bem")
      if (value !== undefined) {
        await db.insert(finAssetValuations).values({
          assetId: asset.id,
          date: date ?? today(),
          value,
          source: source ?? "Atualizado por você",
        })
      }
      return { ok: true as const }
    },
  )
}
