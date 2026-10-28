/**
 * Importação de extratos (F07–F09, F16–F18, F34, F61). Cada arquivo vira um lote desfazível:
 * as linhas novas e as que foram juntadas a lançamentos existentes ficam no histórico do lote.
 */
import { randomUUID } from "node:crypto"
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm"
import { db } from "../../db/client.js"
import {
  finAccounts,
  finCategories,
  finImportBatches,
  finInvoices,
  finRecurring,
  finRules,
  finTransactions,
} from "../../db/schema.js"
import { HttpError, notFound } from "../../lib/http.js"
import { enqueue } from "../../lib/jobs.js"
import { addDays, daysBetween, firstDay, monthOf, today } from "./dates.js"
import {
  displayDescription,
  fingerprints,
  installmentGroup,
  looksLikeCardBillPayment,
  merchantKey,
  normalizeText,
  parseInstallment,
  referencedMerchant,
  rowKind,
} from "./normalize.js"
import {
  type ParsedRow,
  type ParsedStatement,
  parseStatement,
  StatementParseError,
} from "./parse.js"
import { firstMatchingRule } from "./rules.js"
import { snapshot, snapshotCreated, undoOperation, withSplits } from "./service.js"

type Account = typeof finAccounts.$inferSelect
type Counts = Record<
  | "read"
  | "inserted"
  | "duplicates"
  | "merged"
  | "promoted"
  | "rules"
  | "review"
  | "transfers"
  | "future",
  number
>

/** Escolhe a conta do extrato: a informada (conferindo o tipo) ou a única compatível. */
async function resolveAccount(parsed: ParsedStatement, accountId?: string): Promise<Account> {
  const accounts = await db.select().from(finAccounts).where(isNull(finAccounts.archivedAt))
  const compatible = (a: Account) =>
    parsed.accountType === "credit_card" ? a.type === "credit_card" : a.type !== "credit_card"
  if (accountId) {
    const account = accounts.find((a) => a.id === accountId)
    if (!account) throw new HttpError(400, "invalid_account", "Conta não encontrada.")
    if (!compatible(account)) {
      throw new HttpError(
        400,
        "account_mismatch",
        "Este arquivo é de outro tipo de conta (cartão × conta corrente).",
      )
    }
    return account
  }
  const candidates = accounts.filter((a) => compatible(a) && a.institution === parsed.institution)
  if (candidates.length === 1) return candidates[0]!
  throw new HttpError(400, "account_required", "Escolha a conta deste extrato.")
}

/** Fatura do cartão (F05): fechamento = último dia do arquivo; vencimento pelo dia padrão da conta. */
async function upsertInvoice(account: Account, parsed: ParsedStatement) {
  if (account.type !== "credit_card" || !parsed.periodEnd) return null
  const closing = parsed.periodEnd
  let due = addDays(closing, 8)
  if (account.dueDay) {
    due = `${monthOf(closing)}-${String(account.dueDay).padStart(2, "0")}`
    if (due <= closing)
      due = `${monthOf(addDays(`${monthOf(closing)}-01`, 32))}-${String(account.dueDay).padStart(2, "0")}`
  }
  if (!account.closingDay) {
    // Aprende o ciclo com o primeiro arquivo; dá para mudar depois nas datas da fatura.
    await db
      .update(finAccounts)
      .set({ closingDay: Number(closing.slice(8)), dueDay: Number(due.slice(8)) })
      .where(eq(finAccounts.id, account.id))
  }
  const total = parsed.balance ? Math.abs(parsed.balance.amount) : null
  const [invoice] = await db
    .insert(finInvoices)
    .values({
      accountId: account.id,
      referenceMonth: firstDay(monthOf(due)),
      closingDate: closing,
      bestPurchaseDate: addDays(closing, 1),
      dueDate: due,
      statementTotal: total,
    })
    .onConflictDoUpdate({
      target: [finInvoices.accountId, finInvoices.referenceMonth],
      set: { statementTotal: total ?? sql`${finInvoices.statementTotal}` },
    })
    .returning()
  return invoice ?? null
}

export async function importStatement(input: {
  buffer: Uint8Array
  fileName: string
  accountId?: string
  /** Ignora lançamentos antes deste dia (carga inicial "desde 1/10"). */
  since?: string
}) {
  let parsed: ParsedStatement
  try {
    parsed = parseStatement(input.buffer)
  } catch (error) {
    if (error instanceof StatementParseError)
      throw new HttpError(400, "invalid_statement", error.message)
    throw error
  }
  if (!parsed.rows.length && !parsed.periodEnd) {
    throw new HttpError(400, "empty_statement", "O arquivo não tem lançamentos.")
  }
  const account = await resolveAccount(parsed, input.accountId)
  const isCard = account.type === "credit_card"
  // A fatura vem do arquivo inteiro: o total do banco vale mesmo com compras antes do corte (F81).
  const invoice = await upsertInvoice(account, parsed)
  // Carga inicial "desde": lançamentos antes do dia ficam de fora, inclusive no cartão.
  const since = input.since
  const keep = (r: ParsedRow) => !since || r.date >= since
  const skipped = parsed.rows.filter((r) => !keep(r)).length
  if (since) {
    parsed = {
      ...parsed,
      rows: parsed.rows.filter(keep),
      periodStart: parsed.periodStart && parsed.periodStart > since ? parsed.periodStart : since,
    }
    if (parsed.periodEnd && parsed.periodEnd < since) parsed.periodEnd = undefined
  }
  const now = today()
  const cutoff = parsed.generatedOn && parsed.generatedOn < now ? parsed.generatedOn : now
  const coverageEnd = parsed.periodEnd && parsed.periodEnd > cutoff ? cutoff : parsed.periodEnd

  const [batch] = await db
    .insert(finImportBatches)
    .values({
      accountId: account.id,
      fileName: input.fileName.slice(0, 200),
      format: parsed.format,
      invoiceId: invoice?.id ?? null,
      periodStart:
        parsed.periodStart && coverageEnd && parsed.periodStart > coverageEnd
          ? null
          : (parsed.periodStart ?? null),
      periodEnd:
        parsed.periodStart && coverageEnd && parsed.periodStart > coverageEnd
          ? null
          : (coverageEnd ?? null),
    })
    .returning()
  const batchId = batch!.id

  const counts: Counts = {
    read: parsed.rows.length,
    inserted: 0,
    duplicates: 0,
    merged: 0,
    promoted: 0,
    rules: 0,
    review: 0,
    transfers: 0,
    future: 0,
  }
  const rules = await db.select().from(finRules).where(eq(finRules.enabled, true))
  const categories = await db.select().from(finCategories).where(isNull(finCategories.archivedAt))
  const taxCategory = categories.find((c) => normalizeText(c.name) === "IMPOSTOS E TAXAS")
  const prints = fingerprints(parsed.rows)
  const existing = new Map(
    (
      await db
        .select({
          id: finTransactions.id,
          fingerprint: finTransactions.fingerprint,
          status: finTransactions.status,
        })
        .from(finTransactions)
        .where(
          and(
            eq(finTransactions.accountId, account.id),
            isNotNull(finTransactions.fingerprint),
            isNull(finTransactions.deletedAt),
          ),
        )
    ).map((r) => [r.fingerprint!, r]),
  )
  const insertedIds: string[] = []
  const ruleHits = new Map<string, number>()

  for (const [i, row] of parsed.rows.entries()) {
    const fingerprint = prints[i]!
    const future = row.date > cutoff
    const kind = rowKind(row, isCard)
    const merchant = merchantKey(
      kind === "iof" || kind === "refund"
        ? (referencedMerchant(row.description) ?? row.description)
        : row.description,
    )

    // Já importado: só promove uma parcela futura que agora chegou de verdade.
    const seen = existing.get(fingerprint)
    if (seen) {
      if (seen.status === "planned" && !future) {
        const [before] = await withSplits(
          await db.select().from(finTransactions).where(eq(finTransactions.id, seen.id)),
        )
        await snapshot(batchId, [before!])
        await db
          .update(finTransactions)
          .set({
            status: before!.categoryId ? "confirmed" : "review",
            importBatchId: batchId,
            invoiceId: invoice?.id ?? before!.invoiceId,
          })
          .where(eq(finTransactions.id, seen.id))
        counts.promoted++
      } else counts.duplicates++
      continue
    }

    // F34: junta com um lançamento manual (mesma conta, mesmo valor, até 3 dias).
    const bankData = {
      originalDescription: row.description,
      merchant,
      fingerprint,
      externalId: row.externalId ?? null,
      importBatchId: batchId,
      invoiceId: invoice?.id ?? null,
      manual: false,
    }
    if (!future) {
      const [manual] = await db
        .select()
        .from(finTransactions)
        .where(
          and(
            eq(finTransactions.accountId, account.id),
            eq(finTransactions.manual, true),
            eq(finTransactions.amount, row.amount),
            isNull(finTransactions.fingerprint),
            isNull(finTransactions.deletedAt),
            gte(finTransactions.date, addDays(row.date, -3)),
            lte(finTransactions.date, addDays(row.date, 3)),
          ),
        )
        .orderBy(sql`abs(${finTransactions.date} - ${row.date}::date)`)
        .limit(1)
      if (manual) {
        await snapshot(batchId, await withSplits([manual]))
        await db
          .update(finTransactions)
          .set({ ...bankData, date: row.date })
          .where(eq(finTransactions.id, manual.id))
        counts.merged++
        continue
      }

      // F19: casa com a ocorrência prevista de um recorrente (valor dentro da tolerância, até 10 dias).
      const planned = await db
        .select({ tx: finTransactions, rec: finRecurring })
        .from(finTransactions)
        .innerJoin(finRecurring, eq(finRecurring.id, finTransactions.recurringId))
        .where(
          and(
            eq(finTransactions.accountId, account.id),
            eq(finTransactions.status, "planned"),
            isNull(finTransactions.fingerprint),
            isNull(finTransactions.deletedAt),
            gte(finTransactions.date, addDays(row.date, -10)),
            lte(finTransactions.date, addDays(row.date, 10)),
          ),
        )
      const match = planned
        .filter(({ tx, rec }) => {
          if (Math.sign(tx.amount) !== Math.sign(row.amount)) return false
          const expected = Math.abs(tx.amount)
          if (Math.abs(Math.abs(row.amount) - expected) > (expected * rec.tolerancePct) / 100)
            return false
          return (
            !rec.matchPattern ||
            normalizeText(row.description).includes(normalizeText(rec.matchPattern))
          )
        })
        .sort(
          (a, b) =>
            Math.abs(daysBetween(a.tx.date, row.date)) - Math.abs(daysBetween(b.tx.date, row.date)),
        )[0]
      if (match) {
        await snapshot(batchId, await withSplits([match.tx]))
        await db
          .update(finTransactions)
          .set({
            ...bankData,
            date: row.date,
            amount: row.amount,
            status: match.tx.categoryId ? "confirmed" : "review",
          })
          .where(eq(finTransactions.id, match.tx.id))
        counts.merged++
        continue
      }
    }

    // Linha nova: classe, categoria e parcela.
    const installment = parseInstallment(row.description)
    let cls: "normal" | "transfer" = "normal"
    let categoryId: string | null = null
    let categorySource: "rule" | null = null
    let ruleId: string | null = null
    let nature: "fixed" | "variable" | null = null
    let description = displayDescription(installment?.base ?? row.description)
    let aiQuestion: string | null = null
    let notes: string | null = installment
      ? `Parcela ${installment.number} de ${installment.total}`
      : null

    if (kind === "card_payment" || (!isCard && looksLikeCardBillPayment(row.description)))
      cls = "transfer"
    const rule =
      cls === "normal"
        ? firstMatchingRule(rules, {
            description: row.description,
            accountId: account.id,
            amount: row.amount,
          })
        : undefined
    if (rule) {
      ruleHits.set(rule.id, (ruleHits.get(rule.id) ?? 0) + 1)
      ruleId = rule.id
      if (rule.action === "transfer") cls = "transfer"
      else if (rule.action === "ask")
        aiQuestion = "Você pediu para sempre perguntar sobre este lugar. O que foi?"
      else {
        categoryId = rule.categoryId
        categorySource = "rule"
        nature = rule.nature
        if (rule.renameTo) description = rule.renameTo
      }
    } else if (kind === "iof" && taxCategory) {
      categoryId = taxCategory.id
      categorySource = "rule"
    } else if (kind === "refund") {
      // F59: estorno herda a categoria da compra original (mesma loja, até 90 dias antes).
      const [original] = await db
        .select()
        .from(finTransactions)
        .where(
          and(
            eq(finTransactions.accountId, account.id),
            eq(finTransactions.merchant, merchant),
            sql`${finTransactions.amount} < 0`,
            isNotNull(finTransactions.categoryId),
            isNull(finTransactions.deletedAt),
            gte(finTransactions.date, addDays(row.date, -90)),
            lte(finTransactions.date, row.date),
          ),
        )
        .orderBy(desc(finTransactions.date))
        .limit(1)
      notes = original
        ? `Estorno de ${original.date.slice(8)}/${original.date.slice(5, 7)}`
        : "Estorno"
      if (original) {
        categoryId = original.categoryId
        categorySource = "rule"
      } else aiQuestion = "Estorno sem a compra original por aqui. Qual categoria?"
    } else if (installment) {
      // Parcela seguinte de uma compra já categorizada herda a categoria.
      const group = installmentGroup(account.id, installment.base, installment.total, row.amount)
      const [sibling] = await db
        .select({ categoryId: finTransactions.categoryId })
        .from(finTransactions)
        .where(
          and(
            eq(finTransactions.installmentGroup, group),
            isNotNull(finTransactions.categoryId),
            isNull(finTransactions.deletedAt),
          ),
        )
        .limit(1)
      if (sibling) {
        categoryId = sibling.categoryId
        categorySource = "rule"
      }
    }

    const status = future ? "planned" : cls === "transfer" || categoryId ? "confirmed" : "review"
    const [created] = await db
      .insert(finTransactions)
      .values({
        ...bankData,
        accountId: account.id,
        date: row.date,
        amount: row.amount,
        class: cls,
        description,
        categoryId,
        categorySource,
        ruleId,
        nature,
        status,
        aiQuestion,
        // "Sempre perguntar" não passa pela IA (F12).
        aiTriedAt: aiQuestion ? new Date() : null,
        installmentGroup: installment
          ? installmentGroup(account.id, installment.base, installment.total, row.amount)
          : null,
        installmentNumber: installment?.number ?? null,
        installmentTotal: installment?.total ?? null,
        notes,
        createdBy: "user",
      })
      .returning({ id: finTransactions.id })
    insertedIds.push(created!.id)
    existing.set(fingerprint, { id: created!.id, fingerprint, status })
    counts.inserted++
    if (future) counts.future++
    if (cls === "transfer") {
      counts.transfers++
    } else if (categorySource === "rule") counts.rules++
    else if (status === "review") counts.review++
  }

  await snapshotCreated(batchId, insertedIds)
  for (const [id, n] of ruleHits) {
    await db
      .update(finRules)
      .set({ hits: sql`${finRules.hits} + ${n}`, lastHitAt: new Date() })
      .where(eq(finRules.id, id))
  }
  const converted = await pairTransfers(insertedIds)
  counts.transfers += converted.length
  counts.review -= converted.filter((c) => c.status === "review").length
  counts.rules -= converted.filter((c) => c.categorySource === "rule").length
  const balanceCheck = await updateBalances(account, parsed, input.since)
  if (skipped) Object.assign(counts, { skipped })

  await db
    .update(finImportBatches)
    .set({ counts, balanceCheck })
    .where(eq(finImportBatches.id, batchId))
  if (counts.review)
    await enqueue("finance.categorize", {}, { singleton: true, key: "finance.categorize" })
  const [saved] = await db.select().from(finImportBatches).where(eq(finImportBatches.id, batchId))
  return saved!
}

/**
 * F17: liga as duas pontas de uma transferência (valores opostos, até 3 dias, outra conta).
 * Uma ponta já é transferência (ex.: "Pagamento recebido" no cartão); a outra pode ter entrado
 * como lançamento comum (ex.: "PIX ENVIADO" no Bradesco) e vira transferência também.
 * Devolve as linhas que mudaram de comum para transferência.
 */
async function pairTransfers(ids: string[]) {
  const converted: { id: string; status: string; categorySource: string | null }[] = []
  for (const id of ids) {
    const [tx] = await db.select().from(finTransactions).where(eq(finTransactions.id, id))
    if (!tx || tx.transferGroupId || tx.status === "planned") continue
    const [other] = await db
      .select()
      .from(finTransactions)
      .where(
        and(
          ne(finTransactions.accountId, tx.accountId),
          eq(finTransactions.amount, -tx.amount),
          tx.class === "transfer" ? sql`true` : eq(finTransactions.class, "transfer"),
          ne(finTransactions.status, "planned"),
          isNull(finTransactions.transferGroupId),
          isNull(finTransactions.deletedAt),
          gte(finTransactions.date, addDays(tx.date, -3)),
          lte(finTransactions.date, addDays(tx.date, 3)),
        ),
      )
      .orderBy(sql`${finTransactions.class} = 'transfer' desc`)
      .limit(1)
    if (!other) continue
    const normal = tx.class === "normal" ? tx : other.class === "normal" ? other : null
    if (normal) {
      // Só lançamentos sem categoria do usuário viram transferência sozinhos.
      if (normal.categorySource === "user") continue
      await db
        .update(finTransactions)
        .set({
          class: "transfer",
          categoryId: null,
          categorySource: null,
          status: "confirmed",
          aiQuestion: null,
        })
        .where(eq(finTransactions.id, normal.id))
      if (normal.id === tx.id)
        converted.push({ id: tx.id, status: tx.status, categorySource: tx.categorySource })
    }
    await db
      .update(finTransactions)
      .set({ transferGroupId: randomUUID() })
      .where(inArray(finTransactions.id, [tx.id, other.id]))
  }
  return converted
}

/**
 * F18: saldo inicial automático (pelo primeiro extrato com saldo) e conferência com o banco.
 * Só conta corrente; no cartão o "saldo" do arquivo é o total da fatura.
 */
async function updateBalances(account: Account, parsed: ParsedStatement, since?: string) {
  if (account.type === "credit_card" || !parsed.balance) return null
  const first = parsed.rows.find((r) => r.balanceAfter !== undefined)
  let openingDate = account.openingDate
  let openingBalance = account.openingBalance
  if (first && first.balanceAfter !== undefined) {
    // Com corte por data, o saldo vale na véspera do corte (nada mudou entre o corte e a 1ª linha).
    const candidate = addDays(since && first.date >= since ? since : first.date, -1)
    if (!openingDate || candidate < openingDate) {
      // Saldo antes da primeira linha = saldo depois dela − ela − as linhas anteriores do mesmo dia.
      const sameDayBefore = parsed.rows
        .slice(0, parsed.rows.indexOf(first))
        .reduce((s, r) => s + r.amount, 0)
      openingBalance = first.balanceAfter - first.amount - sameDayBefore
      openingDate = candidate
    }
  } else if (!openingDate && parsed.periodStart) {
    openingDate = addDays(parsed.periodStart, -1)
    openingBalance =
      parsed.balance.amount -
      parsed.rows.filter((r) => r.date <= parsed.balance!.date).reduce((s, r) => s + r.amount, 0)
  }
  const newer = !account.bankBalanceDate || parsed.balance.date >= account.bankBalanceDate
  await db
    .update(finAccounts)
    .set({
      openingBalance,
      openingDate,
      ...(newer
        ? { bankBalance: parsed.balance.amount, bankBalanceDate: parsed.balance.date }
        : {}),
    })
    .where(eq(finAccounts.id, account.id))
  if (!openingDate) return null
  const [sum] = await db
    .select({ total: sql<number>`coalesce(sum(${finTransactions.amount}), 0)::bigint` })
    .from(finTransactions)
    .where(
      and(
        eq(finTransactions.accountId, account.id),
        ne(finTransactions.status, "planned"),
        isNull(finTransactions.deletedAt),
        sql`${finTransactions.date} > ${openingDate}`,
        lte(finTransactions.date, parsed.balance.date),
      ),
    )
  return {
    date: parsed.balance.date,
    bank: parsed.balance.amount,
    computed: openingBalance + Number(sum?.total ?? 0),
  }
}

/** Desfaz o lote: apaga as linhas novas e devolve as juntadas ao estado anterior (F09). */
export async function undoImport(batchId: string) {
  const [batch] = await db.select().from(finImportBatches).where(eq(finImportBatches.id, batchId))
  if (!batch) throw notFound("Importação")
  if (batch.status === "undone")
    throw new HttpError(409, "already_undone", "Esta importação já foi desfeita.")
  try {
    await undoOperation(batchId)
  } catch (error) {
    // Lote sem nenhuma linha nova nem juntada (só duplicadas): nada a desfazer além do status.
    if (!(error instanceof HttpError && error.statusCode === 404)) throw error
  }
  await db
    .update(finImportBatches)
    .set({ status: "undone", undoneAt: new Date() })
    .where(eq(finImportBatches.id, batchId))
}
