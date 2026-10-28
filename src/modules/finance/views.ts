/** Dados prontos para cada tela do Financeiro (Visão geral, Extratos, Planejamento, Patrimônio, Revisar). */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm"
import { db } from "../../db/client.js"
import {
  finAccounts,
  finAssetValuations,
  finAssets,
  finImportBatches,
  finInvoices,
  finRecurring,
  finRuleSuggestions,
  finTransactions,
} from "../../db/schema.js"
import {
  type CategoryLite,
  categoryBreakdown,
  isDeferredOut,
  isPayable,
  monthCoverage,
  monthTotals,
  periodOf,
  rowFlag,
  txKind,
} from "./compute.js"
import { addDays, addMonths, dayInMonth, firstDay, lastDay, monthOf, today } from "./dates.js"
import {
  ensureOccurrences,
  getFinanceSettings,
  loadCategories,
  loadRange,
  toLite,
  type TxWithSplits,
  withSplits,
} from "./service.js"
import { debtsLeftAt } from "./debts.js"

type Account = typeof finAccounts.$inferSelect

const accountsMap = async () =>
  new Map(
    (
      await db
        .select()
        .from(finAccounts)
        .orderBy(asc(finAccounts.position), asc(finAccounts.createdAt))
    ).map((a) => [a.id, a]),
  )

/** Transação como a interface usa: selo, se dá para "Já paguei", se o valor é editável. */
export function txDto(
  tx: TxWithSplits,
  ctx: { month: string; today: string; accounts: Map<string, Account> },
) {
  const lite = toLite(tx)
  const accountType = ctx.accounts.get(tx.accountId)?.type
  return {
    id: tx.id,
    accountId: tx.accountId,
    date: tx.date,
    amount: tx.amount,
    class: tx.class,
    description: tx.description,
    originalDescription: tx.originalDescription,
    categoryId: tx.categoryId,
    nature: tx.nature,
    status: tx.status,
    categorySource: tx.categorySource,
    aiConfidence: tx.aiConfidence,
    aiQuestion: tx.aiQuestion,
    aiSuggestions: tx.aiSuggestions ?? [],
    installment:
      tx.installmentNumber && tx.installmentTotal
        ? { number: tx.installmentNumber, total: tx.installmentTotal }
        : null,
    recurringId: tx.recurringId,
    recurringPeriod: tx.recurringPeriod,
    deferredFrom: tx.deferredFrom,
    deferralReason: tx.deferralReason,
    manual: tx.manual,
    notes: tx.notes,
    splits: tx.splits,
    /** No cartão, vencimento da fatura em que a compra cai (F81). */
    invoiceDue: tx.invoiceDue,
    flag: rowFlag(lite, ctx.month, ctx.today),
    payable: isPayable(lite, accountType, ctx.month),
    /** Valor e conta só mudam em lançamentos manuais e previstos (F31). */
    editableAmount: (tx.manual || tx.status === "planned") && tx.class === "normal",
  }
}
export type TxDto = ReturnType<typeof txDto>

/** Saldo de uma conta corrente no fim do dia `day` (F18). null se o saldo inicial é depois. */
async function balanceAt(account: Account, day: string): Promise<number | null> {
  if (!account.openingDate || account.openingDate > day) return null
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${finTransactions.amount}), 0)::bigint` })
    .from(finTransactions)
    .where(
      and(
        eq(finTransactions.accountId, account.id),
        ne(finTransactions.status, "planned"),
        isNull(finTransactions.deletedAt),
        gt(finTransactions.date, account.openingDate),
        lte(finTransactions.date, day),
      ),
    )
  return account.openingBalance + Number(row?.total ?? 0)
}

/** Previstas de uma conta até `day` (para a projeção do fim do mês, F40). */
async function plannedUntil(accountId: string, from: string, to: string) {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${finTransactions.amount}), 0)::bigint` })
    .from(finTransactions)
    .where(
      and(
        eq(finTransactions.accountId, accountId),
        eq(finTransactions.status, "planned"),
        isNull(finTransactions.deletedAt),
        gte(finTransactions.date, from),
        lte(finTransactions.date, to),
      ),
    )
  return Number(row?.total ?? 0)
}

/**
 * Faturas do cartão que vencem de `fromMonth` a `toMonth` (F81). O valor é tudo que cai nela
 * (compras, previstas e rotativo), ou o total do banco, se for maior: com o corte da carga inicial,
 * a fatura pode ter compras de antes do corte que não estão no app. `paid` = pagamentos recebidos
 * entre o fechamento e o vencimento.
 */
async function cardBills(fromMonth: string, toMonth: string, accounts: Map<string, Account>) {
  const cards = [...accounts.values()].filter((a) => !a.archivedAt && a.type === "credit_card")
  if (!cards.length) return []
  const invoices = await db.select().from(finInvoices)
  const txs = await loadRange(firstDay(addMonths(fromMonth, -2)), lastDay(toMonth))
  const bills: {
    accountId: string
    month: string
    closingDate: string
    dueDate: string
    amount: number
    paid: number
  }[] = []
  for (const card of cards) {
    const mine = txs.filter((t) => t.accountId === card.id)
    for (let m = fromMonth; m <= toMonth; m = addMonths(m, 1)) {
      const invoice = invoices.find(
        (i) => i.accountId === card.id && i.referenceMonth === firstDay(m),
      )
      const dueDate = invoice?.dueDate ?? (card.dueDay ? dayInMonth(m, card.dueDay) : null)
      if (!dueDate) continue
      const closingDate =
        invoice?.closingDate ??
        (card.closingDay
          ? dayInMonth((card.dueDay ?? 0) > card.closingDay ? m : addMonths(m, -1), card.closingDay)
          : addDays(dueDate, -8))
      const fromTxs = -mine
        .filter(
          (t) =>
            t.invoiceDue &&
            monthOf(t.invoiceDue) === m &&
            !(t.class === "transfer" && t.amount > 0),
        )
        .reduce((s, t) => s + t.amount, 0)
      const amount = Math.max(fromTxs, invoice?.statementTotal ?? 0)
      const paid = mine
        .filter(
          (t) =>
            t.class === "transfer" && t.amount > 0 && t.date > closingDate && t.date <= dueDate,
        )
        .reduce((s, t) => s + t.amount, 0)
      if (amount > 0)
        bills.push({ accountId: card.id, month: m, closingDate, dueDate, amount, paid })
    }
  }
  return bills
}

/**
 * Conta corrente no fim do mês (F82): a primeira conta corrente com saldo acompanhado paga o
 * cartão. Saldo de hoje + previstas dela até o fim do mês (inclusive as vencidas) + o que entra nas
 * contas só de repasse (F78, ex.: Salário Ana, que vai para o cartão) − faturas que vencem de hoje
 * até o fim do mês, descontado o que já foi pago depois do fechamento. Mês que já passou: o saldo
 * real no último dia (F83).
 */
async function cashForecast(month: string, accounts: Map<string, Account>, now: string) {
  const list = [...accounts.values()].filter((a) => !a.archivedAt)
  const payer = list.find((a) => a.trackBalance && a.type === "checking")
  if (!payer) return null
  const end = lastDay(month)
  if (end < now) {
    const closed = await balanceAt(payer, end)
    if (closed === null) return null
    return {
      accountId: payer.id,
      balance: closed,
      planned: 0,
      passThrough: 0,
      cardDue: 0,
      bills: [],
      projected: closed,
    }
  }
  const balance = await balanceAt(payer, now)
  if (balance === null) return null
  const planned = await plannedUntil(payer.id, "0001-01-01", end)
  let passThrough = 0
  for (const a of list.filter((x) => !x.trackBalance && x.type !== "credit_card"))
    passThrough += await plannedUntil(a.id, now, end)

  const bills = (await cardBills(monthOf(now), month, accounts))
    .filter((b) => b.dueDate >= now)
    .map((b) => ({ accountId: b.accountId, dueDate: b.dueDate, amount: b.amount - b.paid }))
    .filter((b) => b.amount > 0)
  const cardDue = bills.reduce((s, b) => s + b.amount, 0)
  return {
    accountId: payer.id,
    balance,
    planned,
    passThrough,
    cardDue,
    bills,
    projected: balance + planned + passThrough - cardDue,
  }
}

/**
 * Fatura do cartão em aberto (F05/F65): compras e créditos depois do fechamento da última fatura
 * já vencida, até `day`. As parcelas futuras ficam de fora (são "parcelas a vencer").
 */
async function cardOpen(account: Account, day: string) {
  const [paid] = await db
    .select({ closing: sql<string | null>`max(${finInvoices.closingDate})` })
    .from(finInvoices)
    .where(and(eq(finInvoices.accountId, account.id), sql`${finInvoices.dueDate} < ${day}`))
  const since = paid?.closing ?? "1900-01-01"
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${finTransactions.amount}), 0)::bigint` })
    .from(finTransactions)
    .where(
      and(
        eq(finTransactions.accountId, account.id),
        // Tudo que aumenta a fatura (compras, IOF, rotativo) e os créditos comuns; os pagamentos
        // ("Pagamento recebido") quitam a fatura anterior e ficam de fora.
        sql`not (${finTransactions.class} = 'transfer' and ${finTransactions.amount} > 0)`,
        ne(finTransactions.status, "planned"),
        isNull(finTransactions.deletedAt),
        gt(finTransactions.date, since),
        lte(finTransactions.date, day),
      ),
    )
  const [next] = await db
    .select()
    .from(finInvoices)
    .where(and(eq(finInvoices.accountId, account.id), gte(finInvoices.dueDate, day)))
    .orderBy(asc(finInvoices.dueDate))
    .limit(1)
  return { amount: -Number(row?.total ?? 0), since, invoice: next ?? null }
}

// ─── Visão geral (6.1) ──────────────────────────────────────────────────────

export async function overview(month: string) {
  const now = today()
  const curMonth = monthOf(now)
  if (month >= curMonth) await ensureOccurrences(curMonth, addMonths(curMonth, 3))
  const [cats, accounts, settings] = await Promise.all([
    loadCategories(),
    accountsMap(),
    getFinanceSettings(),
  ])
  const inMonth = await loadRange(firstDay(month), lastDay(month))
  // Faturas que vencem no mês: entram nas saídas no lugar das compras do cartão (F81).
  const bills = (await cardBills(month, month, accounts)).map((b) => ({
    accountId: b.accountId,
    closingDate: b.closingDate,
    dueDate: b.dueDate,
    amount: b.amount,
    paid: b.dueDate < now || b.paid >= b.amount,
  }))
  // Adiadas para fora do mês aparecem na data original, fora do total (F29); o filtro final é o
  // isDeferredOut.
  const deferredOut = await withSplits(
    await db
      .select()
      .from(finTransactions)
      .where(
        and(
          isNull(finTransactions.deletedAt),
          isNotNull(finTransactions.deferredFrom),
          gte(finTransactions.deferredFrom, firstDay(addMonths(month, -2))),
          lte(finTransactions.deferredFrom, lastDay(month)),
        ),
      ),
  )
  const history = await loadRange(firstDay(addMonths(month, -3)), lastDay(addMonths(month, -1)))
  const lite = inMonth.map(toLite)
  const ctx = { month, today: now, accounts }
  const totals = monthTotals(lite, cats, {
    month,
    today: now,
    goal: settings.monthlySavingGoal,
    bills,
  })
  const categories = categoryBreakdown(lite, history.map(toLite), cats, month)

  const flow = { income: [] as TxDto[], expense: [] as TxDto[] }
  for (const tx of [...inMonth, ...deferredOut.filter((t) => isDeferredOut(toLite(t), month))]) {
    if (tx.class !== "normal") continue
    flow[txKind(toLite(tx), cats)].push(txDto(tx, ctx))
  }
  const sortKey = (t: TxDto) => (t.flag === "deferred_out" ? t.deferredFrom! : t.date)
  for (const side of [flow.income, flow.expense])
    side.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))

  // Alertas do "Precisa de você" (só fazem sentido olhando o mês atual).
  const [review] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(finTransactions)
    .where(and(eq(finTransactions.status, "review"), isNull(finTransactions.deletedAt)))
  const [suggestions] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(finRuleSuggestions)
    .where(eq(finRuleSuggestions.status, "pending"))
  const overdue =
    month === curMonth
      ? lite
          .filter((t) => t.status === "planned" && t.date < now && !t.invoiceDue)
          .map((t) =>
            txDto(
              inMonth.find((x) => x.id === t.id)!,
              ctx,
            ),
          )
      : []
  const cash = await cashForecast(month, accounts, now)
  // Saldos de hoje das contas correntes (F83); as só de repasse não têm saldo acompanhado.
  const balances: { accountId: string; balance: number | null }[] = []
  for (const account of accounts.values()) {
    if (account.archivedAt || account.type !== "checking") continue
    balances.push({
      accountId: account.id,
      balance: account.trackBalance ? await balanceAt(account, now) : null,
    })
  }
  const negativeAccounts: { accountId: string; projected: number }[] = []
  if (month === curMonth) {
    for (const account of accounts.values()) {
      if (account.archivedAt || !account.trackBalance || account.type === "credit_card") continue
      if (cash?.accountId === account.id) {
        if (cash.projected < 0)
          negativeAccounts.push({ accountId: account.id, projected: cash.projected })
        continue
      }
      const balance = await balanceAt(account, now)
      if (balance === null) continue
      const projected = balance + (await plannedUntil(account.id, now, lastDay(month)))
      if (projected < 0) negativeAccounts.push({ accountId: account.id, projected })
    }
  }
  const [lastData] = await db
    .select({ end: sql<string | null>`max(${finImportBatches.periodEnd})` })
    .from(finImportBatches)
    .where(eq(finImportBatches.status, "done"))

  return {
    month,
    today: now,
    totals,
    categories,
    flow,
    bills,
    cash,
    balances,
    alerts: {
      reviewCount: (review?.n ?? 0) + (suggestions?.n ?? 0),
      overdue,
      negativeAccounts,
      statementsUntil: lastData?.end ?? null,
    },
  }
}

// ─── Extratos (F61) ─────────────────────────────────────────────────────────

export async function statements(monthsBack = 3) {
  const now = today()
  const curMonth = monthOf(now)
  const accounts = [...(await accountsMap()).values()].filter(
    (a) => !a.archivedAt && a.trackBalance && a.type !== "cash",
  )
  const batches = await db.select().from(finImportBatches).orderBy(desc(finImportBatches.createdAt))
  const done = batches.filter((b) => b.status === "done" && b.periodStart && b.periodEnd)
  const earliest = done.reduce(
    (m, b) => (monthOf(b.periodStart!) < m ? monthOf(b.periodStart!) : m),
    curMonth,
  )
  const from =
    earliest < addMonths(curMonth, -monthsBack) ? addMonths(curMonth, -monthsBack) : earliest
  const months: string[] = []
  for (let m = from; m <= curMonth; m = addMonths(m, 1)) months.push(m)

  return {
    today: now,
    months: months.map((month) => ({
      month,
      accounts: accounts.map((account) => {
        const mine = done.filter((b) => b.accountId === account.id)
        const coverage = monthCoverage(
          mine.map((b) => ({ start: b.periodStart!, end: b.periodEnd! })),
          month,
          now,
        )
        const files = batches.filter(
          (b) =>
            b.accountId === account.id &&
            ((b.periodStart &&
              b.periodEnd &&
              b.periodEnd >= firstDay(month) &&
              b.periodStart <= lastDay(month)) ||
              (!b.periodStart && monthOf(b.createdAt.toISOString().slice(0, 10)) === month)),
        )
        return {
          accountId: account.id,
          ...coverage,
          lastImportAt: files.find((b) => b.status === "done")?.createdAt.toISOString() ?? null,
          files: files.map((b) => ({
            id: b.id,
            fileName: b.fileName,
            format: b.format,
            createdAt: b.createdAt.toISOString(),
            periodStart: b.periodStart,
            periodEnd: b.periodEnd,
            counts: b.counts,
            balanceCheck: b.balanceCheck,
            status: b.status,
          })),
        }
      }),
    })),
  }
}

// ─── Planejamento (F42/F64) ─────────────────────────────────────────────────

export async function planning(month: string) {
  const now = today()
  const curMonth = monthOf(now)
  await ensureOccurrences(curMonth, addMonths(curMonth, 6))
  const accounts = await accountsMap()
  const recs = await db
    .select()
    .from(finRecurring)
    .orderBy(asc(finRecurring.direction), asc(finRecurring.dayOfMonth))
  const active = recs.filter(
    (r) => r.startsOn <= lastDay(month) && (!r.endsOn || r.endsOn >= firstDay(month)),
  )
  // As do mês e as atrasadas de meses anteriores que caíram neste (pelo mês do lançamento, F81).
  const occurrences = (
    await withSplits(
      await db
        .select()
        .from(finTransactions)
        .where(
          and(
            inArray(
              finTransactions.recurringId,
              active.length ? active.map((r) => r.id) : ["00000000-0000-0000-0000-000000000000"],
            ),
            isNull(finTransactions.deletedAt),
            sql`(${finTransactions.recurringPeriod} = ${firstDay(month)} or (${finTransactions.recurringPeriod} < ${firstDay(month)} and ${finTransactions.date} >= ${firstDay(addMonths(month, -2))}))`,
          ),
        ),
    )
  ).filter((t) => t.recurringPeriod === firstDay(month) || t.month === month)
  const ctx = { month, today: now, accounts }

  // Compras parceladas: agrupadas pelo grupo da parcela; o que falta vem das faturas futuras já
  // importadas e, além delas, da conta (total − última parcela conhecida).
  const installmentRows = await db
    .select()
    .from(finTransactions)
    .where(and(isNotNull(finTransactions.installmentGroup), isNull(finTransactions.deletedAt)))
    .orderBy(asc(finTransactions.date))
  const groups = new Map<string, (typeof installmentRows)[number][]>()
  for (const row of installmentRows) {
    const list = groups.get(row.installmentGroup!) ?? []
    list.push(row)
    groups.set(row.installmentGroup!, list)
  }
  const installments = [...groups.values()]
    .map((rows) => {
      const last = rows[rows.length - 1]!
      const per = Math.abs(last.amount)
      const total = last.installmentTotal!
      const knownMax = Math.max(...rows.map((r) => r.installmentNumber ?? 0))
      const paid = rows.filter((r) => r.status !== "planned" && r.date <= now)
      const currentNumber = paid.length ? Math.max(...paid.map((r) => r.installmentNumber ?? 0)) : 0
      const lastMonth = addMonths(monthOf(last.date), total - knownMax)
      return {
        group: last.installmentGroup!,
        description: last.description,
        accountId: last.accountId,
        amount: per,
        currentNumber,
        total,
        lastMonth,
        remaining: per * Math.max(0, total - currentNumber),
        categoryId: last.categoryId,
      }
    })
    .filter((i) => i.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining)

  const fixedOut = active
    .filter((r) => r.direction === "out")
    .reduce((s, r) => s + r.expectedAmount, 0)
  const fixedIn = active
    .filter((r) => r.direction === "in")
    .reduce((s, r) => s + r.expectedAmount, 0)
  const commitments = [1, 2, 3, 4, 5, 6].map((n) => {
    const m = addMonths(curMonth, n)
    const inst = installments.filter(
      (i) => m <= i.lastMonth && addMonths(curMonth, i.total - i.currentNumber) >= m,
    )
    const installmentsTotal = inst.reduce((s, i) => s + i.amount, 0)
    return {
      month: m,
      installments: installmentsTotal,
      installmentNames: inst.map((i) => i.description),
      fixedExpenses: fixedOut,
      committed: installmentsTotal + fixedOut,
      fixedIncome: fixedIn,
      leftBeforeVariable: fixedIn - installmentsTotal - fixedOut,
    }
  })

  return {
    month,
    recurring: active.map((r) => {
      const own = occurrences.find(
        (t) => t.recurringId === r.id && t.recurringPeriod === firstDay(month),
      )
      const late = occurrences.filter((t) => t.recurringId === r.id && periodOf(toLite(t)) < month)
      return {
        id: r.id,
        name: r.name,
        direction: r.direction,
        dayOfMonth: r.dayOfMonth,
        expectedAmount: r.expectedAmount,
        tolerancePct: r.tolerancePct,
        accountId: r.accountId,
        categoryId: r.categoryId,
        matchPattern: r.matchPattern,
        startsOn: r.startsOn,
        endsOn: r.endsOn,
        occurrence: own ? txDto(own, ctx) : null,
        late: late.map((t) => txDto(t, ctx)),
      }
    }),
    installments,
    commitments,
    totals: { fixedIncome: fixedIn, fixedExpenses: fixedOut },
  }
}

// ─── Patrimônio (F65) ───────────────────────────────────────────────────────

async function assetsAt(day: string) {
  const assets = await db.select().from(finAssets).where(isNull(finAssets.archivedAt))
  const valuations = await db
    .select()
    .from(finAssetValuations)
    .where(lte(finAssetValuations.date, day))
    .orderBy(desc(finAssetValuations.date), desc(finAssetValuations.createdAt))
  const earliest = await db.select().from(finAssetValuations).orderBy(asc(finAssetValuations.date))
  return assets.map((a) => {
    // Antes da primeira avaliação, vale a mais antiga (o bem já existia; só não tinha valor anotado).
    const v = valuations.find((x) => x.assetId === a.id) ?? earliest.find((x) => x.assetId === a.id)
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      value: v?.value ?? 0,
      valuedAt: v?.date ?? null,
      source: v?.source ?? null,
    }
  })
}

/** Parcelas que ainda vão cair depois de `day` (faturas futuras já importadas). */
async function installmentsAfter(day: string) {
  const rows = await db
    .select()
    .from(finTransactions)
    .where(
      and(
        isNotNull(finTransactions.installmentGroup),
        eq(finTransactions.class, "normal"),
        isNull(finTransactions.deletedAt),
        gt(finTransactions.date, day),
      ),
    )
  return rows.reduce((s, r) => s - r.amount, 0)
}

export async function netWorth() {
  const now = today()
  // Contas só de repasse não têm saldo acompanhado.
  const accounts = [...(await accountsMap()).values()].filter(
    (a) => !a.archivedAt && a.trackBalance,
  )
  const checking = []
  const cards = []
  for (const account of accounts) {
    if (account.type === "credit_card") {
      const open = await cardOpen(account, now)
      cards.push({ accountId: account.id, open: open.amount, invoice: open.invoice })
    } else {
      const balance = await balanceAt(account, now)
      checking.push({
        accountId: account.id,
        balance,
        projectedEndOfMonth:
          balance === null
            ? null
            : balance + (await plannedUntil(account.id, now, lastDay(monthOf(now)))),
        bankBalance: account.bankBalance,
        bankBalanceDate: account.bankBalanceDate,
      })
    }
  }
  const assets = await assetsAt(now)
  const installmentsLeft = await installmentsAfter(now)
  const have =
    checking.reduce((s, c) => s + (c.balance ?? 0), 0) + assets.reduce((s, a) => s + a.value, 0)
  const debtsLeft = await debtsLeftAt(now)
  const owe = cards.reduce((s, c) => s + Math.max(0, c.open), 0) + installmentsLeft + debtsLeft

  // Evolução: fim de cada um dos últimos 6 meses (o mês atual até hoje).
  const series = []
  for (let n = 5; n >= 0; n--) {
    const m = addMonths(monthOf(now), -n)
    const day = n === 0 ? now : lastDay(m)
    let total = 0
    let known = false
    for (const account of accounts) {
      if (account.type === "credit_card")
        total -= Math.max(0, (await cardOpen(account, day)).amount)
      else {
        const b = await balanceAt(account, day)
        if (b !== null) {
          total += b
          known = true
        }
      }
    }
    total += (await assetsAt(day)).reduce((s, a) => s + a.value, 0)
    total -= await installmentsAfter(day)
    total -= await debtsLeftAt(day)
    series.push({ month: m, total: known ? total : null })
  }
  return {
    today: now,
    checking,
    cards,
    assets,
    installmentsLeft,
    debtsLeft,
    have,
    owe,
    total: have - owe,
    series,
  }
}

// ─── Revisar (F37) ──────────────────────────────────────────────────────────

export async function reviewQueue() {
  const now = today()
  const accounts = await accountsMap()
  const rows = await withSplits(
    await db
      .select()
      .from(finTransactions)
      .where(and(eq(finTransactions.status, "review"), isNull(finTransactions.deletedAt)))
      .orderBy(asc(finTransactions.date)),
  )
  const merchants = [...new Set(rows.map((r) => r.merchant).filter((m): m is string => !!m))]
  const history = merchants.length
    ? await db
        .select({
          merchant: finTransactions.merchant,
          date: finTransactions.date,
          categoryId: finTransactions.categoryId,
          amount: finTransactions.amount,
        })
        .from(finTransactions)
        .where(
          and(
            inArray(finTransactions.merchant, merchants),
            isNotNull(finTransactions.categoryId),
            isNull(finTransactions.deletedAt),
          ),
        )
        .orderBy(desc(finTransactions.date))
    : []
  const sameCount = new Map<string, number>()
  for (const r of rows)
    if (r.merchant) sameCount.set(r.merchant, (sameCount.get(r.merchant) ?? 0) + 1)
  const suggestions = await db
    .select()
    .from(finRuleSuggestions)
    .where(eq(finRuleSuggestions.status, "pending"))
  return {
    items: rows.map((tx) => ({
      ...txDto(tx, { month: tx.month, today: now, accounts }),
      /** "Antes neste lugar": últimas compras categorizadas do mesmo estabelecimento. */
      context: history
        .filter((h) => h.merchant === tx.merchant)
        .slice(0, 3)
        .map(({ date, categoryId, amount }) => ({ date, categoryId, amount })),
      /** Outras pendentes iguais ("aplicar também às N iguais"). */
      sameCount: tx.merchant ? (sameCount.get(tx.merchant) ?? 1) - 1 : 0,
    })),
    ruleSuggestions: suggestions,
  }
}

export type { CategoryLite }
