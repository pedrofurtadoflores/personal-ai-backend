/** Esquemas Zod do Financeiro: validação das rotas e contrato OpenAPI (tipos do front). */
import { z } from "zod"

export const dayParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD.")
export const monthParam = z.string().regex(/^\d{4}-\d{2}$/, "Use AAAA-MM.")
/** Centavos. */
export const centsSchema = z.number().int()
export const idParams = z.object({ id: z.uuid() })

export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["checking", "credit_card", "cash", "other"]),
  institution: z.enum(["nubank", "bradesco", "other"]),
  holder: z.string().nullable(),
  closingDay: z.number().nullable(),
  dueDay: z.number().nullable(),
  openingBalance: centsSchema,
  openingDate: z.string().nullable(),
  bankBalance: centsSchema.nullable(),
  bankBalanceDate: z.string().nullable(),
  trackBalance: z.boolean(),
  position: z.number(),
  archivedAt: z.date().nullable(),
})

export const categorySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["income", "expense"]),
  nature: z.enum(["fixed", "variable"]),
  position: z.number(),
  archivedAt: z.date().nullable(),
})

const flagSchema = z
  .enum([
    "deferred_out",
    "in_invoice",
    "deferred_in",
    "paid_late",
    "paid_early",
    "overdue",
    "due_today",
  ])
  .nullable()

export const txSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  date: z.string(),
  amount: centsSchema,
  class: z.enum(["normal", "transfer", "adjustment"]),
  description: z.string(),
  originalDescription: z.string().nullable(),
  categoryId: z.string().nullable(),
  nature: z.enum(["fixed", "variable"]).nullable(),
  status: z.enum(["planned", "review", "auto", "confirmed"]),
  categorySource: z.enum(["user", "rule", "ai"]).nullable(),
  aiConfidence: z.number().nullable(),
  aiQuestion: z.string().nullable(),
  aiSuggestions: z.array(z.string()),
  installment: z.object({ number: z.number(), total: z.number() }).nullable(),
  recurringId: z.string().nullable(),
  recurringPeriod: z.string().nullable(),
  deferredFrom: z.string().nullable(),
  deferralReason: z.string().nullable(),
  manual: z.boolean(),
  notes: z.string().nullable(),
  splits: z.array(z.object({ categoryId: z.string().nullable(), amount: centsSchema })).nullable(),
  /** No cartão, vencimento da fatura em que a compra cai (F81). */
  invoiceDue: z.string().nullable(),
  flag: flagSchema,
  payable: z.boolean(),
  editableAmount: z.boolean(),
})

export const operationSchema = z.object({ operationId: z.string() })

export const ruleSuggestionSchema = z.object({
  id: z.string(),
  pattern: z.string(),
  categoryId: z.string(),
  evidence: z.number(),
  status: z.enum(["pending", "accepted", "dismissed"]),
  createdAt: z.date(),
})

export const overviewSchema = z.object({
  month: z.string(),
  today: z.string(),
  totals: z.object({
    incomeRealized: centsSchema,
    incomePlanned: centsSchema,
    expenseRealized: centsSchema,
    expensePlanned: centsSchema,
    fixedIncome: centsSchema,
    variableIncome: centsSchema,
    fixedExpense: centsSchema,
    variableExpense: centsSchema,
    surplus: centsSchema,
    goal: centsSchema,
    free: centsSchema,
    daysLeft: z.number(),
    freePerDay: centsSchema.nullable(),
  }),
  categories: z.array(
    z.object({
      categoryId: z.string().nullable(),
      amount: centsSchema,
      average: centsSchema.nullable(),
    }),
  ),
  flow: z.object({ income: z.array(txSchema), expense: z.array(txSchema) }),
  /** Faturas que vencem no mês: entram nas saídas no lugar das compras do cartão (F81). */
  bills: z.array(
    z.object({
      accountId: z.string(),
      closingDate: z.string(),
      dueDate: z.string(),
      amount: centsSchema,
      paid: z.boolean(),
    }),
  ),
  /** Conta corrente no fim do mês (F82): previsão no mês atual e nos seguintes; saldo real nos que passaram. */
  cash: z
    .object({
      accountId: z.string(),
      balance: centsSchema,
      planned: centsSchema,
      passThrough: centsSchema,
      cardDue: centsSchema,
      bills: z.array(z.object({ accountId: z.string(), dueDate: z.string(), amount: centsSchema })),
      projected: centsSchema,
    })
    .nullable(),
  /** Saldos de hoje das contas correntes (F83); null nas só de repasse. */
  balances: z.array(z.object({ accountId: z.string(), balance: centsSchema.nullable() })),
  alerts: z.object({
    reviewCount: z.number(),
    overdue: z.array(txSchema),
    negativeAccounts: z.array(z.object({ accountId: z.string(), projected: centsSchema })),
    statementsUntil: z.string().nullable(),
  }),
})

const batchSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  format: z.string(),
  createdAt: z.string(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  counts: z.record(z.string(), z.number()),
  balanceCheck: z.object({ date: z.string(), bank: centsSchema, computed: centsSchema }).nullable(),
  status: z.enum(["done", "failed", "undone"]),
})

export const statementsSchema = z.object({
  today: z.string(),
  months: z.array(
    z.object({
      month: z.string(),
      accounts: z.array(
        z.object({
          accountId: z.string(),
          status: z.enum(["done", "pending", "open", "none", "future"]),
          coveredUntil: z.string().nullable(),
          lastImportAt: z.string().nullable(),
          files: z.array(batchSchema),
        }),
      ),
    }),
  ),
})

export const importResultSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  fileName: z.string(),
  format: z.string(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  counts: z.record(z.string(), z.number()),
  balanceCheck: z.object({ date: z.string(), bank: centsSchema, computed: centsSchema }).nullable(),
})

export const ruleSchema = z.object({
  id: z.string(),
  matchType: z.enum(["contains", "equals", "regex"]),
  pattern: z.string(),
  accountId: z.string().nullable(),
  minAmount: centsSchema.nullable(),
  maxAmount: centsSchema.nullable(),
  sign: z.number().nullable(),
  action: z.enum(["categorize", "ask", "transfer"]),
  categoryId: z.string().nullable(),
  renameTo: z.string().nullable(),
  nature: z.enum(["fixed", "variable"]).nullable(),
  priority: z.number(),
  enabled: z.boolean(),
  hits: z.number(),
  lastHitAt: z.date().nullable(),
})

export const recurringSchema = z.object({
  id: z.string(),
  name: z.string(),
  direction: z.enum(["in", "out"]),
  dayOfMonth: z.number(),
  expectedAmount: centsSchema,
  tolerancePct: z.number(),
  accountId: z.string(),
  categoryId: z.string().nullable(),
  matchPattern: z.string().nullable(),
  startsOn: z.string(),
  endsOn: z.string().nullable(),
})

export const planningSchema = z.object({
  month: z.string(),
  recurring: z.array(
    recurringSchema.extend({ occurrence: txSchema.nullable(), late: z.array(txSchema) }),
  ),
  installments: z.array(
    z.object({
      group: z.string(),
      description: z.string(),
      accountId: z.string(),
      amount: centsSchema,
      currentNumber: z.number(),
      total: z.number(),
      lastMonth: z.string(),
      remaining: centsSchema,
      categoryId: z.string().nullable(),
    }),
  ),
  commitments: z.array(
    z.object({
      month: z.string(),
      installments: centsSchema,
      installmentNames: z.array(z.string()),
      fixedExpenses: centsSchema,
      committed: centsSchema,
      fixedIncome: centsSchema,
      leftBeforeVariable: centsSchema,
    }),
  ),
  totals: z.object({ fixedIncome: centsSchema, fixedExpenses: centsSchema }),
})

const invoiceSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  referenceMonth: z.string(),
  closingDate: z.string(),
  bestPurchaseDate: z.string(),
  dueDate: z.string(),
  statementTotal: centsSchema.nullable(),
})

export const netWorthSchema = z.object({
  today: z.string(),
  checking: z.array(
    z.object({
      accountId: z.string(),
      balance: centsSchema.nullable(),
      projectedEndOfMonth: centsSchema.nullable(),
      bankBalance: centsSchema.nullable(),
      bankBalanceDate: z.string().nullable(),
    }),
  ),
  cards: z.array(
    z.object({ accountId: z.string(), open: centsSchema, invoice: invoiceSchema.nullable() }),
  ),
  assets: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.enum(["vehicle", "real_estate", "investment", "other"]),
      value: centsSchema,
      valuedAt: z.string().nullable(),
      source: z.string().nullable(),
    }),
  ),
  installmentsLeft: centsSchema,
  /** Quanto falta pagar das dívidas (F84). */
  debtsLeft: centsSchema,
  have: centsSchema,
  owe: centsSchema,
  total: centsSchema,
  series: z.array(z.object({ month: z.string(), total: centsSchema.nullable() })),
})

export const reviewSchema = z.object({
  items: z.array(
    txSchema.extend({
      context: z.array(
        z.object({ date: z.string(), categoryId: z.string().nullable(), amount: centsSchema }),
      ),
      sameCount: z.number(),
    }),
  ),
  ruleSuggestions: z.array(ruleSuggestionSchema),
})

export { invoiceSchema }
