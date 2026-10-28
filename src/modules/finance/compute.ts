/**
 * Contas do mês, puras (sem banco): totais, livre para gastar, categorias × média, selos das
 * linhas e cobertura dos extratos. As rotas só carregam os dados e chamam estas funções.
 */
import {
  addDays,
  addMonths,
  dayInMonth,
  daysBetween,
  firstDay,
  lastDay,
  lastDayNumber,
  monthOf,
} from "./dates.js"

export type CategoryLite = {
  id: string
  name: string
  kind: "income" | "expense"
  nature: "fixed" | "variable"
}

/** Ciclo do cartão (F81): dias padrão e as faturas conhecidas, em ordem de fechamento. */
export type CardCycle = {
  closingDay: number | null
  dueDay: number | null
  invoices: { closingDate: string; referenceMonth: string }[]
}

/**
 * Mês em que conta uma compra do cartão feita em `date` (F81): o mês de vencimento da fatura em que
 * ela cai. Usa a fatura conhecida que fecha em até 35 dias; sem ela, os dias padrão da conta.
 */
export function cardMonth(date: string, cycle: CardCycle): string {
  const known = cycle.invoices.find(
    (i) => i.closingDate >= date && daysBetween(date, i.closingDate) <= 35,
  )
  if (known) return monthOf(known.referenceMonth)
  if (!cycle.closingDay) return monthOf(date)
  const closingMonth =
    date <= dayInMonth(monthOf(date), cycle.closingDay)
      ? monthOf(date)
      : addMonths(monthOf(date), 1)
  return (cycle.dueDay ?? 0) > cycle.closingDay ? closingMonth : addMonths(closingMonth, 1)
}

export type TxLite = {
  id: string
  accountId: string
  date: string
  /** Mês da data. */
  month: string
  /** Mês da data antes do adiamento (F29). */
  deferredMonth: string | null
  /** No cartão: vencimento da fatura. A compra aparece no mês dela, mas soma pela fatura (F81). */
  invoiceDue: string | null
  amount: number
  class: "normal" | "transfer" | "adjustment"
  categoryId: string | null
  nature: "fixed" | "variable" | null
  status: "planned" | "review" | "auto" | "confirmed"
  splits: { categoryId: string | null; amount: number }[] | null
  recurringId: string | null
  recurringPeriod: string | null
  deferredFrom: string | null
  manual: boolean
}

export type Line = { tx: TxLite; categoryId: string | null; amount: number }

export const linesOf = (tx: TxLite): Line[] =>
  tx.splits?.length
    ? tx.splits.map((s) => ({ tx, categoryId: s.categoryId, amount: s.amount }))
    : [{ tx, categoryId: tx.categoryId, amount: tx.amount }]

/** Ganho ou gasto vem da categoria, não do sinal (F06): estorno numa despesa reduz a despesa. */
export function lineKind(line: Line, cats: Map<string, CategoryLite>): "income" | "expense" {
  const cat = line.categoryId ? cats.get(line.categoryId) : undefined
  return cat ? cat.kind : line.amount > 0 ? "income" : "expense"
}

export function lineNature(line: Line, cats: Map<string, CategoryLite>): "fixed" | "variable" {
  if (line.tx.nature) return line.tx.nature
  const cat = line.categoryId ? cats.get(line.categoryId) : undefined
  return cat?.nature ?? "variable"
}

/** Lado do fluxo em que a transação aparece (pela primeira parte, se dividida). */
export const txKind = (tx: TxLite, cats: Map<string, CategoryLite>) =>
  lineKind(linesOf(tx)[0]!, cats)

/** Mês a que a ocorrência pertence (F19/F29): o período do recorrente ou o mês antes do adiamento. */
export function periodOf(tx: Pick<TxLite, "recurringPeriod" | "deferredMonth" | "month">): string {
  return tx.recurringPeriod ? monthOf(tx.recurringPeriod) : (tx.deferredMonth ?? tx.month)
}

/** Adiada para fora deste mês: aparece na data original, fora do total (F29). */
export const isDeferredOut = (tx: TxLite, month: string) =>
  !!tx.deferredFrom && tx.month !== month && periodOf(tx) === month

export type RowFlag =
  | "deferred_out"
  | "in_invoice"
  | "deferred_in"
  | "paid_late"
  | "paid_early"
  | "overdue"
  | "due_today"
  | null

/** Selo da linha (F33): só o que pede atenção. */
export function rowFlag(tx: TxLite, month: string, today: string): RowFlag {
  if (isDeferredOut(tx, month)) return "deferred_out"
  if (tx.invoiceDue) return "in_invoice"
  const period = periodOf(tx)
  const txMonth = tx.month
  if (tx.deferredFrom && period < txMonth)
    return tx.status === "planned" ? "deferred_in" : "paid_late"
  if (tx.recurringId && period > txMonth && tx.status !== "planned") return "paid_early"
  if (tx.status === "planned" && tx.date < today) return "overdue"
  if (tx.status === "planned" && tx.date === today) return "due_today"
  return null
}

/** "Já paguei" só vale para previstas de conta corrente; as do cartão caem sozinhas na fatura (F57). */
export const isPayable = (tx: TxLite, accountType: string | undefined, month: string) =>
  tx.status === "planned" && accountType !== "credit_card" && !isDeferredOut(tx, month)

export type MonthTotals = {
  incomeRealized: number
  incomePlanned: number
  expenseRealized: number
  expensePlanned: number
  fixedIncome: number
  variableIncome: number
  fixedExpense: number
  variableExpense: number
  surplus: number
  goal: number
  free: number
  daysLeft: number
  freePerDay: number | null
}

/**
 * Totais do mês (F30/F39/F58). Entram as transações `normal` com data no mês, menos as compras do
 * cartão, que entram pela fatura do mês em que ela vence (`bills`, F81). As previstas e as faturas
 * ainda não pagas contam como "a receber"/"a pagar". Valores de despesa são positivos aqui.
 */
export function monthTotals(
  txs: TxLite[],
  cats: Map<string, CategoryLite>,
  opts: { month: string; today: string; goal: number; bills?: { amount: number; paid: boolean }[] },
): MonthTotals {
  const t = {
    incomeRealized: 0,
    incomePlanned: 0,
    expenseRealized: 0,
    expensePlanned: 0,
    fixedIncome: 0,
    variableIncome: 0,
    fixedExpense: 0,
    variableExpense: 0,
  }
  for (const tx of txs) {
    if (tx.class !== "normal" || tx.month !== opts.month || tx.invoiceDue) continue
    for (const line of linesOf(tx)) {
      const planned = tx.status === "planned"
      const fixed = lineNature(line, cats) === "fixed"
      if (lineKind(line, cats) === "income") {
        t[planned ? "incomePlanned" : "incomeRealized"] += line.amount
        t[fixed ? "fixedIncome" : "variableIncome"] += line.amount
      } else {
        t[planned ? "expensePlanned" : "expenseRealized"] -= line.amount
        t[fixed ? "fixedExpense" : "variableExpense"] -= line.amount
      }
    }
  }
  for (const bill of opts.bills ?? []) {
    t[bill.paid ? "expenseRealized" : "expensePlanned"] += bill.amount
    t.variableExpense += bill.amount
  }
  const surplus = t.incomeRealized + t.incomePlanned - t.expenseRealized - t.expensePlanned
  const free = surplus - opts.goal
  const curMonth = monthOf(opts.today)
  const daysLeft =
    opts.month === curMonth
      ? lastDayNumber(opts.month) - Number(opts.today.slice(8)) + 1
      : opts.month > curMonth
        ? lastDayNumber(opts.month)
        : 0
  return {
    ...t,
    surplus,
    goal: opts.goal,
    free,
    daysLeft,
    freePerDay: daysLeft > 0 ? Math.floor(free / daysLeft) : null,
  }
}

export type CategoryRow = { categoryId: string | null; amount: number; average: number | null }

/**
 * Gastos por categoria no mês (F48) com a média dos meses anteriores que têm dados (até 3).
 * `history` = transações dos 3 meses anteriores.
 */
export function categoryBreakdown(
  monthTxs: TxLite[],
  history: TxLite[],
  cats: Map<string, CategoryLite>,
  month: string,
): CategoryRow[] {
  const sum = (txs: TxLite[], inMonth: (d: string) => boolean) => {
    const by = new Map<string | null, number>()
    for (const tx of txs) {
      if (tx.class !== "normal" || !inMonth(tx.month)) continue
      for (const line of linesOf(tx)) {
        if (lineKind(line, cats) !== "expense") continue
        by.set(line.categoryId, (by.get(line.categoryId) ?? 0) - line.amount)
      }
    }
    return by
  }
  const current = sum(monthTxs, (m) => m === month)
  const histMonths = [
    ...new Set(history.filter((t) => t.class === "normal").map((t) => t.month)),
  ].filter((m) => m < month)
  const hist = sum(history, (m) => m < month)
  return [...current.entries()]
    .filter(([, amount]) => amount !== 0)
    .map(([categoryId, amount]) => ({
      categoryId,
      amount,
      average:
        categoryId && histMonths.length
          ? Math.round((hist.get(categoryId) ?? 0) / histMonths.length)
          : null,
    }))
    .sort((a, b) => (a.categoryId === null ? 1 : b.categoryId === null ? -1 : b.amount - a.amount))
}

export type Coverage = {
  status: "done" | "pending" | "open" | "none" | "future"
  coveredUntil: string | null
}

/**
 * Situação de um mês numa conta (F61) a partir dos intervalos que os extratos cobrem.
 * `done` = mês fechado coberto do dia 1 ao último dia; `pending` = fechado com buraco;
 * `open` = mês atual; `future` = ainda não começou.
 */
export function monthCoverage(
  intervals: { start: string; end: string }[],
  month: string,
  today: string,
): Coverage {
  const start = firstDay(month)
  const end = lastDay(month)
  if (start > today) return { status: "future", coveredUntil: null }
  const sorted = intervals
    .filter((i) => i.end >= start && i.start <= end)
    .sort((a, b) => a.start.localeCompare(b.start))
  // Cobertura contínua a partir do dia 1.
  let until: string | null = null
  let cursor = start
  for (const i of sorted) {
    if (i.start > cursor) break
    if (i.end >= cursor) {
      until = i.end > end ? end : i.end
      cursor = addDays(until, 1)
    }
  }
  if (!sorted.length)
    return { status: monthOf(today) === month ? "open" : "none", coveredUntil: null }
  if (monthOf(today) === month) return { status: "open", coveredUntil: until }
  return { status: until === end ? "done" : "pending", coveredUntil: until }
}
