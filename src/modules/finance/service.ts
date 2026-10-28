/** Operações do Financeiro que tocam o banco: transações, recorrentes, desfazer, revisão. */
import { randomUUID } from "node:crypto"
import { and, asc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm"
import { z } from "zod"
import { db } from "../../db/client.js"
import {
  finAccounts,
  finCategories,
  finChanges,
  finInvoices,
  finRecurring,
  finRuleSuggestions,
  finRules,
  finSplits,
  finTransactions,
} from "../../db/schema.js"
import { HttpError, notFound } from "../../lib/http.js"
import { getInternal, setInternal } from "../settings/service.js"
import { type CardCycle, type CategoryLite, cardMonth, type TxLite } from "./compute.js"
import { addMonths, dayInMonth, firstDay, monthOf, today } from "./dates.js"
import { merchantKey } from "./normalize.js"
import { ruleMatches } from "./rules.js"

export type TxRow = typeof finTransactions.$inferSelect
export type SplitRow = { categoryId: string | null; amount: number }
export type TxWithSplits = TxRow & {
  splits: SplitRow[] | null
  /** Mês da data (e da data antes do adiamento). */
  month: string
  deferredMonth: string | null
  /** No cartão, o vencimento da fatura em que a compra cai (F81); fora do cartão, null. */
  invoiceDue: string | null
}

// ─── Configurações ──────────────────────────────────────────────────────────

export const financeSettingsSchema = z.object({
  /** Meta de guardar por mês, em centavos (F39). */
  monthlySavingGoal: z.number().int().min(0).default(0),
  /** Abaixo disso a IA não categoriza sozinha (F11). */
  aiConfidenceThreshold: z.number().min(0.5).max(1).default(0.85),
})
export type FinanceSettings = z.infer<typeof financeSettingsSchema>
const SETTINGS_KEY = "finance.settings"

export async function getFinanceSettings(): Promise<FinanceSettings> {
  const raw = await getInternal<unknown>(SETTINGS_KEY)
  const parsed = financeSettingsSchema.safeParse(raw ?? {})
  return parsed.success ? parsed.data : financeSettingsSchema.parse({})
}

export async function updateFinanceSettings(patch: Partial<FinanceSettings>) {
  const next = financeSettingsSchema.parse({ ...(await getFinanceSettings()), ...patch })
  await setInternal(SETTINGS_KEY, next)
  return next
}

// ─── Leitura ────────────────────────────────────────────────────────────────

export async function loadCategories() {
  const rows = await db.select().from(finCategories).where(isNull(finCategories.archivedAt))
  return new Map<string, CategoryLite>(rows.map((c) => [c.id, c]))
}

export type InvoiceDueOf = (
  accountId: string,
  date: string,
  invoiceId?: string | null,
) => string | null

/**
 * Vencimento da fatura em que cai cada compra do cartão (F81): a fatura ligada à compra; sem ela,
 * a fatura conhecida ou os dias padrão da conta. Fora do cartão, null.
 */
export async function loadInvoiceDueOf(): Promise<InvoiceDueOf> {
  const cards = await db.select().from(finAccounts).where(eq(finAccounts.type, "credit_card"))
  const invoices = cards.length
    ? await db.select().from(finInvoices).orderBy(asc(finInvoices.closingDate))
    : []
  const byId = new Map(invoices.map((i) => [i.id, i]))
  const cycles = new Map(
    cards.map((a) => {
      const mine = invoices.filter((i) => i.accountId === a.id)
      const cycle: CardCycle = { closingDay: a.closingDay, dueDay: a.dueDay, invoices: mine }
      return [a.id, { cycle, mine, dueDay: a.dueDay }] as const
    }),
  )
  return (accountId, date, invoiceId) => {
    const card = cycles.get(accountId)
    if (!card) return null
    const linked = invoiceId ? byId.get(invoiceId) : undefined
    if (linked) return linked.dueDate
    const month = cardMonth(date, card.cycle)
    const known = card.mine.find((i) => i.referenceMonth === firstDay(month))
    return known?.dueDate ?? dayInMonth(month, card.dueDay ?? 1)
  }
}

export async function withSplits(rows: TxRow[]): Promise<TxWithSplits[]> {
  const invoiceDueOf = await loadInvoiceDueOf()
  const ids = rows.map((r) => r.id)
  const splits = ids.length
    ? await db
        .select()
        .from(finSplits)
        .where(inArray(finSplits.transactionId, ids))
        .orderBy(asc(finSplits.idx))
    : []
  const by = new Map<string, SplitRow[]>()
  for (const s of splits) {
    const list = by.get(s.transactionId) ?? []
    list.push({ categoryId: s.categoryId, amount: s.amount })
    by.set(s.transactionId, list)
  }
  return rows.map((r) => ({
    ...r,
    splits: by.get(r.id) ?? null,
    month: monthOf(r.date),
    deferredMonth: r.deferredFrom ? monthOf(r.deferredFrom) : null,
    invoiceDue: invoiceDueOf(r.accountId, r.date, r.invoiceId),
  }))
}

/** Transações não apagadas com data entre `from` e `to` (inclusive), com divisões. */
export async function loadRange(from: string, to: string) {
  const rows = await db
    .select()
    .from(finTransactions)
    .where(
      and(
        isNull(finTransactions.deletedAt),
        gte(finTransactions.date, from),
        lte(finTransactions.date, to),
      ),
    )
    .orderBy(asc(finTransactions.date), asc(finTransactions.createdAt))
  return withSplits(rows)
}

export async function getTx(id: string): Promise<TxWithSplits> {
  const [row] = await db
    .select()
    .from(finTransactions)
    .where(and(eq(finTransactions.id, id), isNull(finTransactions.deletedAt)))
  if (!row) throw notFound("Transação")
  return (await withSplits([row]))[0]!
}

export const toLite = (tx: TxWithSplits): TxLite => ({
  id: tx.id,
  accountId: tx.accountId,
  date: tx.date,
  month: tx.month,
  deferredMonth: tx.deferredMonth,
  invoiceDue: tx.invoiceDue,
  amount: tx.amount,
  class: tx.class,
  categoryId: tx.categoryId,
  nature: tx.nature,
  status: tx.status,
  splits: tx.splits,
  recurringId: tx.recurringId,
  recurringPeriod: tx.recurringPeriod,
  deferredFrom: tx.deferredFrom,
  manual: tx.manual,
})

// ─── Desfazer (F22) ─────────────────────────────────────────────────────────

/** Guarda o estado de antes de uma ou mais transações, sob uma operação. */
export async function snapshot(
  operationId: string,
  txs: TxWithSplits[],
  author: "user" | "ai" = "user",
) {
  if (!txs.length) return
  await db.insert(finChanges).values(
    txs.map((tx) => ({
      operationId,
      transactionId: tx.id,
      before: JSON.parse(JSON.stringify(tx)) as Record<string, unknown>,
      author,
    })),
  )
}

/** Marca transações criadas pela operação (desfazer = apagar). */
export async function snapshotCreated(
  operationId: string,
  ids: string[],
  author: "user" | "ai" = "user",
) {
  if (!ids.length) return
  await db
    .insert(finChanges)
    .values(ids.map((transactionId) => ({ operationId, transactionId, before: null, author })))
}

const RESTORABLE = [
  "accountId",
  "invoiceId",
  "date",
  "amount",
  "class",
  "description",
  "originalDescription",
  "merchant",
  "categoryId",
  "nature",
  "status",
  "categorySource",
  "ruleId",
  "aiConfidence",
  "aiQuestion",
  "aiSuggestions",
  "transferGroupId",
  "installmentGroup",
  "installmentNumber",
  "installmentTotal",
  "recurringId",
  "recurringPeriod",
  "deferredFrom",
  "deferralReason",
  "manual",
  "importBatchId",
  "externalId",
  "fingerprint",
  "notes",
] as const

export async function undoOperation(operationId: string) {
  const changes = await db.select().from(finChanges).where(eq(finChanges.operationId, operationId))
  if (!changes.length) throw notFound("Operação")
  await db.transaction(async (trx) => {
    for (const change of changes.reverse()) {
      if (!change.before) {
        await trx
          .update(finTransactions)
          .set({ deletedAt: new Date() })
          .where(eq(finTransactions.id, change.transactionId))
        continue
      }
      const before = change.before as Record<string, unknown>
      const values = Object.fromEntries(RESTORABLE.map((k) => [k, before[k] ?? null]))
      await trx
        .update(finTransactions)
        .set({
          ...values,
          manual: Boolean(before.manual),
          deletedAt: before.deletedAt ? new Date(String(before.deletedAt)) : null,
        })
        .where(eq(finTransactions.id, change.transactionId))
      await trx.delete(finSplits).where(eq(finSplits.transactionId, change.transactionId))
      const splits = (before.splits as SplitRow[] | null) ?? []
      if (splits.length)
        await trx
          .insert(finSplits)
          .values(splits.map((s, idx) => ({ transactionId: change.transactionId, idx, ...s })))
    }
    await trx.delete(finChanges).where(eq(finChanges.operationId, operationId))
  })
}

// ─── Recorrentes (F19) ──────────────────────────────────────────────────────

export type RecurringRow = typeof finRecurring.$inferSelect

/**
 * Contas só de repasse não têm extrato para confirmar nada: o que estava previsto nelas se
 * confirma sozinho quando chega a data.
 */
async function confirmUntracked() {
  const untracked = await db
    .select({ id: finAccounts.id })
    .from(finAccounts)
    .where(eq(finAccounts.trackBalance, false))
  if (!untracked.length) return
  await db
    .update(finTransactions)
    .set({
      status: sql`case when ${finTransactions.categoryId} is null then 'review'::fin_tx_status else 'confirmed'::fin_tx_status end`,
    })
    .where(
      and(
        inArray(
          finTransactions.accountId,
          untracked.map((a) => a.id),
        ),
        eq(finTransactions.status, "planned"),
        lte(finTransactions.date, today()),
        isNull(finTransactions.deletedAt),
      ),
    )
}

/** Cria as ocorrências previstas que faltam de `fromMonth` a `toMonth` (inclusive). */
export async function ensureOccurrences(fromMonth: string, toMonth: string) {
  await confirmUntracked()
  const recs = await db.select().from(finRecurring)
  for (const rec of recs) {
    for (let m = fromMonth; m <= toMonth; m = addMonths(m, 1)) {
      if (firstDay(m) < firstDay(monthOf(rec.startsOn))) continue
      if (rec.endsOn && firstDay(m) > rec.endsOn) continue
      await db
        .insert(finTransactions)
        .values(occurrenceValues(rec, m))
        .onConflictDoNothing({
          target: [finTransactions.recurringId, finTransactions.recurringPeriod],
          where: sql`${finTransactions.recurringId} is not null and ${finTransactions.deletedAt} is null`,
        })
    }
  }
}

function occurrenceValues(rec: RecurringRow, month: string) {
  return {
    accountId: rec.accountId,
    date: dayInMonth(month, rec.dayOfMonth),
    amount: (rec.direction === "in" ? 1 : -1) * rec.expectedAmount,
    description: rec.name,
    categoryId: rec.categoryId,
    status: "planned" as const,
    recurringId: rec.id,
    recurringPeriod: firstDay(month),
    createdBy: "user" as const,
  }
}

/** Editar o cadastro muda só as ocorrências ainda previstas, não adiadas e não editadas à mão (F64). */
export async function syncRecurring(rec: RecurringRow) {
  const planned = await db
    .select()
    .from(finTransactions)
    .where(
      and(
        eq(finTransactions.recurringId, rec.id),
        eq(finTransactions.status, "planned"),
        isNull(finTransactions.deferredFrom),
        isNull(finTransactions.deletedAt),
        isNull(finTransactions.notes),
      ),
    )
  for (const tx of planned) {
    const month = monthOf(tx.recurringPeriod ?? tx.date)
    const v = occurrenceValues(rec, month)
    await db
      .update(finTransactions)
      .set({
        date: v.date,
        amount: v.amount,
        description: v.description,
        categoryId: v.categoryId,
        accountId: v.accountId,
      })
      .where(eq(finTransactions.id, tx.id))
  }
}

/** Encerrar: some das ocorrências previstas a partir do mês atual (as pagas ficam). */
export async function endRecurring(id: string) {
  const [rec] = await db.select().from(finRecurring).where(eq(finRecurring.id, id))
  if (!rec) throw notFound("Recorrente")
  const from = firstDay(monthOf(today()))
  await db.update(finRecurring).set({ endsOn: from }).where(eq(finRecurring.id, id))
  await db
    .update(finTransactions)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(finTransactions.recurringId, id),
        eq(finTransactions.status, "planned"),
        gte(finTransactions.date, from),
        isNull(finTransactions.deletedAt),
      ),
    )
}

// ─── Edição de transações ───────────────────────────────────────────────────

export type TxPatch = {
  date?: string
  description?: string
  categoryId?: string | null
  accountId?: string
  amount?: number
  nature?: "fixed" | "variable" | null
  notes?: string | null
  class?: "normal" | "transfer"
}

/** Valor do banco não muda (F31): só lançamentos manuais e previstos aceitam valor e conta. */
export async function updateTransaction(id: string, patch: TxPatch) {
  const tx = await getTx(id)
  const editableMoney = tx.manual || tx.status === "planned"
  if ((patch.amount !== undefined || patch.accountId !== undefined) && !editableMoney) {
    throw new HttpError(
      409,
      "bank_value_locked",
      "O valor e a conta de um lançamento do banco não mudam.",
    )
  }
  if (patch.categoryId) await assertCategory(patch.categoryId)
  const operationId = randomUUID()
  await snapshot(operationId, [tx])
  const set: Partial<typeof finTransactions.$inferInsert> = {}
  if (patch.date !== undefined) set.date = patch.date
  if (patch.description !== undefined) set.description = patch.description.trim() || tx.description
  if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null
  if (patch.nature !== undefined) set.nature = patch.nature
  if (patch.class !== undefined) set.class = patch.class
  if (patch.amount !== undefined) set.amount = patch.amount
  if (patch.accountId !== undefined) set.accountId = patch.accountId
  if (patch.categoryId !== undefined) {
    set.categoryId = patch.categoryId
    set.categorySource = patch.categoryId ? "user" : null
    if (tx.status !== "planned") set.status = patch.categoryId ? "confirmed" : "review"
    set.aiQuestion = patch.categoryId ? null : tx.aiQuestion
  }
  // Transferência entre contas suas não tem categoria nem fica na fila Revisar (F06).
  if (patch.class === "transfer") {
    Object.assign(set, { categoryId: null, categorySource: null, aiQuestion: null })
    if (tx.status !== "planned") set.status = "confirmed"
  } else if (
    patch.class === "normal" &&
    tx.class === "transfer" &&
    !set.categoryId &&
    !tx.categoryId
  ) {
    set.status = "review"
  }
  await db.update(finTransactions).set(set).where(eq(finTransactions.id, id))
  if (patch.categoryId && tx.splits)
    await db.delete(finSplits).where(eq(finSplits.transactionId, id))
  const suggestion = patch.categoryId ? await maybeSuggestRule(tx, patch.categoryId) : null
  return { operationId, suggestion }
}

async function assertCategory(id: string) {
  const [cat] = await db
    .select({ id: finCategories.id })
    .from(finCategories)
    .where(eq(finCategories.id, id))
  if (!cat) throw new HttpError(400, "invalid_category", "Categoria não encontrada.")
}

/**
 * F12: você categorizou o mesmo estabelecimento 2 vezes do mesmo jeito e nenhuma regra cobre?
 * Sugere "sempre categorizar". Uma sugestão recusada não volta.
 */
export async function maybeSuggestRule(tx: TxWithSplits, categoryId: string) {
  const merchant =
    tx.merchant ?? (tx.originalDescription ? merchantKey(tx.originalDescription) : null)
  if (!merchant || merchant.length < 3) return null
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(finTransactions)
    .where(
      and(
        eq(finTransactions.merchant, merchant),
        eq(finTransactions.categoryId, categoryId),
        eq(finTransactions.categorySource, "user"),
        isNull(finTransactions.deletedAt),
      ),
    )
  if ((count?.n ?? 0) < 2) return null
  const rules = await db.select().from(finRules)
  const covered = rules.some((r) =>
    ruleMatches(r, {
      description: tx.originalDescription ?? tx.description,
      accountId: tx.accountId,
      amount: tx.amount,
    }),
  )
  if (covered) return null
  const [created] = await db
    .insert(finRuleSuggestions)
    .values({ pattern: merchant, categoryId, evidence: count!.n })
    .onConflictDoNothing()
    .returning()
  return created ?? null
}

/** Divide em categorias (a soma tem que bater com o valor). Lista vazia desfaz a divisão. */
export async function splitTransaction(id: string, parts: SplitRow[]) {
  const tx = await getTx(id)
  if (parts.length === 1)
    throw new HttpError(400, "split_too_small", "Divida em pelo menos duas partes.")
  if (parts.length && parts.reduce((s, p) => s + p.amount, 0) !== tx.amount) {
    throw new HttpError(
      400,
      "split_mismatch",
      "A soma das partes precisa ser igual ao valor da transação.",
    )
  }
  for (const p of parts) if (p.categoryId) await assertCategory(p.categoryId)
  const operationId = randomUUID()
  await snapshot(operationId, [tx])
  await db.transaction(async (trx) => {
    await trx.delete(finSplits).where(eq(finSplits.transactionId, id))
    if (parts.length) {
      await trx.insert(finSplits).values(parts.map((p, idx) => ({ transactionId: id, idx, ...p })))
      await trx
        .update(finTransactions)
        .set({
          categoryId: null,
          categorySource: "user",
          status:
            tx.status === "planned"
              ? "planned"
              : parts.every((p) => p.categoryId)
                ? "confirmed"
                : "review",
        })
        .where(eq(finTransactions.id, id))
    } else {
      await trx
        .update(finTransactions)
        .set({ categoryId: tx.splits?.[0]?.categoryId ?? null })
        .where(eq(finTransactions.id, id))
    }
  })
  return { operationId }
}

/** Adiar só esta ocorrência (F29). Adiar de novo mantém a data original. */
export async function deferTransaction(id: string, date: string, reason?: string | null) {
  const tx = await getTx(id)
  if (tx.status !== "planned")
    throw new HttpError(409, "not_planned", "Só dá para adiar o que ainda está previsto.")
  const operationId = randomUUID()
  await snapshot(operationId, [tx])
  await db
    .update(finTransactions)
    .set({
      date,
      deferredFrom: tx.deferredFrom ?? tx.date,
      deferralReason: reason?.trim() || tx.deferralReason,
      recurringPeriod: tx.recurringPeriod ?? firstDay(monthOf(tx.deferredFrom ?? tx.date)),
    })
    .where(eq(finTransactions.id, id))
  return { operationId }
}

export async function undeferTransaction(id: string) {
  const tx = await getTx(id)
  if (!tx.deferredFrom) throw new HttpError(409, "not_deferred", "Esta transação não foi adiada.")
  const operationId = randomUUID()
  await snapshot(operationId, [tx])
  await db
    .update(finTransactions)
    .set({ date: tx.deferredFrom, deferredFrom: null, deferralReason: null })
    .where(eq(finTransactions.id, id))
  return { operationId }
}

/** "Já paguei" / "Já recebi" (F57): a prevista vira lançamento manual confirmado. */
export async function payTransaction(
  id: string,
  input: { amount?: number; date: string; accountId?: string },
) {
  const tx = await getTx(id)
  if (tx.status !== "planned")
    throw new HttpError(409, "not_planned", "Esta transação já não está prevista.")
  const accountId = input.accountId ?? tx.accountId
  const [account] = await db.select().from(finAccounts).where(eq(finAccounts.id, accountId))
  if (!account) throw new HttpError(400, "invalid_account", "Conta não encontrada.")
  if (account.type === "credit_card") {
    throw new HttpError(409, "card_charge", "Cobranças do cartão caem sozinhas na fatura.")
  }
  const operationId = randomUUID()
  await snapshot(operationId, [tx])
  const sign = tx.amount > 0 ? 1 : -1
  await db
    .update(finTransactions)
    .set({
      amount: input.amount !== undefined ? sign * Math.abs(input.amount) : tx.amount,
      date: input.date,
      accountId,
      status: tx.categoryId ? "confirmed" : "review",
      manual: true,
      recurringPeriod: tx.recurringPeriod ?? firstDay(monthOf(tx.deferredFrom ?? tx.date)),
    })
    .where(eq(finTransactions.id, id))
  return { operationId }
}

export async function createManualTransaction(input: {
  accountId: string
  date: string
  amount: number
  description: string
  categoryId?: string | null
  notes?: string | null
}) {
  const [account] = await db.select().from(finAccounts).where(eq(finAccounts.id, input.accountId))
  if (!account) throw new HttpError(400, "invalid_account", "Conta não encontrada.")
  if (input.categoryId) await assertCategory(input.categoryId)
  const [row] = await db
    .insert(finTransactions)
    .values({
      accountId: input.accountId,
      date: input.date,
      amount: input.amount,
      description: input.description.trim() || "Lançamento",
      categoryId: input.categoryId ?? null,
      categorySource: input.categoryId ? "user" : null,
      status: input.categoryId ? "confirmed" : "review",
      aiQuestion: input.categoryId ? null : "Lançado sem categoria. Qual é?",
      manual: true,
      notes: input.notes?.trim() || null,
    })
    .returning()
  const operationId = randomUUID()
  await snapshotCreated(operationId, [row!.id])
  return { transaction: row!, operationId }
}

/** Só lançamentos manuais e previstos podem ser apagados; os do banco somem desfazendo a importação. */
export async function deleteTransaction(id: string) {
  const tx = await getTx(id)
  if (!tx.manual && tx.status !== "planned") {
    throw new HttpError(
      409,
      "bank_value_locked",
      "Lançamentos do banco saem desfazendo a importação.",
    )
  }
  const operationId = randomUUID()
  await snapshot(operationId, [tx])
  await db.update(finTransactions).set({ deletedAt: new Date() }).where(eq(finTransactions.id, id))
  return { operationId }
}

// ─── Revisão (F37) ──────────────────────────────────────────────────────────

/** Resolve um item da fila; `applyToSame` aplica às outras pendentes do mesmo estabelecimento. */
export async function resolveReview(
  id: string,
  input: { categoryId: string; applyToSame?: boolean; description?: string },
) {
  const tx = await getTx(id)
  await assertCategory(input.categoryId)
  const targets = [tx]
  if (input.applyToSame && tx.merchant) {
    const same = await db
      .select()
      .from(finTransactions)
      .where(
        and(
          eq(finTransactions.merchant, tx.merchant),
          eq(finTransactions.status, "review"),
          ne(finTransactions.id, id),
          isNull(finTransactions.deletedAt),
        ),
      )
    targets.push(...(await withSplits(same)))
  }
  const operationId = randomUUID()
  await snapshot(operationId, targets)
  await db
    .update(finTransactions)
    .set({
      categoryId: input.categoryId,
      categorySource: "user",
      status: "confirmed",
      aiQuestion: null,
    })
    .where(
      inArray(
        finTransactions.id,
        targets.map((t) => t.id),
      ),
    )
  if (input.description?.trim()) {
    await db
      .update(finTransactions)
      .set({ description: input.description.trim() })
      .where(eq(finTransactions.id, id))
  }
  const suggestion = await maybeSuggestRule(tx, input.categoryId)
  return { operationId, resolved: targets.length, suggestion }
}

/** Aceitar a sugestão cria a regra e aplica às pendentes iguais. */
export async function acceptRuleSuggestion(id: string) {
  const [s] = await db.select().from(finRuleSuggestions).where(eq(finRuleSuggestions.id, id))
  if (!s || s.status !== "pending") throw notFound("Sugestão")
  const [rule] = await db
    .insert(finRules)
    .values({
      matchType: "contains",
      pattern: s.pattern,
      categoryId: s.categoryId,
      action: "categorize",
    })
    .returning()
  await db
    .update(finRuleSuggestions)
    .set({ status: "accepted" })
    .where(eq(finRuleSuggestions.id, id))
  await db
    .update(finTransactions)
    .set({
      categoryId: s.categoryId,
      categorySource: "rule",
      ruleId: rule!.id,
      status: "confirmed",
      aiQuestion: null,
    })
    .where(
      and(
        eq(finTransactions.merchant, s.pattern),
        inArray(finTransactions.status, ["review", "auto"]),
        isNull(finTransactions.deletedAt),
      ),
    )
  return rule!
}
