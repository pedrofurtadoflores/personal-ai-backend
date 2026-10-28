import { afterAll, describe, expect, it } from "vitest"
import { pool } from "../src/db/client.js"
import {
  cardMonth,
  type CategoryLite,
  categoryBreakdown,
  monthCoverage,
  monthTotals,
  rowFlag,
  type TxLite,
} from "../src/modules/finance/compute.js"
import { addMonths, dayInMonth, lastDay, today } from "../src/modules/finance/dates.js"
import {
  fingerprints,
  merchantKey,
  parseInstallment,
  referencedMerchant,
  rowKind,
} from "../src/modules/finance/normalize.js"
import { parseMoney, parseStatement, StatementParseError } from "../src/modules/finance/parse.js"
import { parseQuick } from "../src/modules/finance/quick.js"
import { firstMatchingRule, ruleMatches } from "../src/modules/finance/rules.js"
import { BRADESCO_CSV, FEB_INVOICE, OCT_INVOICE } from "./finance-fixtures.js"

afterAll(() => pool.end())

const bytes = (text: string) => new TextEncoder().encode(text)

describe("datas", () => {
  it("meses, último dia e dia limitado ao mês", () => {
    expect(addMonths("2026-11", 3)).toBe("2027-02")
    expect(lastDay("2027-02")).toBe("2027-02-28")
    expect(dayInMonth("2027-02", 31)).toBe("2027-02-28")
    expect(today(new Date("2026-10-29T02:00:00Z"))).toBe("2026-10-28") // 23h em São Paulo
  })
})

describe("leitura dos extratos", () => {
  it("valores em pt-BR e com ponto", () => {
    expect(parseMoney("1.234,56")).toBe(123456)
    expect(parseMoney("-108.66")).toBe(-10866)
    expect(parseMoney(" ")).toBeNull()
  })

  it("fatura do Nubank em OFX: período, saldo, data de geração e todas as linhas", () => {
    const s = parseStatement(bytes(OCT_INVOICE))
    expect(s).toMatchObject({
      format: "ofx_card",
      institution: "nubank",
      accountType: "credit_card",
      periodStart: "2026-09-04",
      periodEnd: "2026-10-03", // DTEND é exclusivo na fatura
      balance: { amount: -48050, date: "2026-10-04" },
      generatedOn: "2026-10-28",
    })
    expect(s.rows).toHaveLength(9)
    expect(s.rows[1]).toEqual({
      date: "2026-10-03",
      amount: -380,
      description: 'IOF de "Servico Nuvem Inc."',
      externalId: "aaa-1",
    })
  })

  it("extrato do Bradesco em CSV: pula título e rodapé, ignora os futuros, lê o saldo e a data-base", () => {
    const s = parseStatement(bytes(BRADESCO_CSV))
    expect(s).toMatchObject({
      format: "bradesco_csv",
      institution: "bradesco",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-28",
      balance: { amount: 460200, date: "2026-10-28" },
    })
    expect(s.rows.map((r) => r.amount)).toEqual([-690, 500000, -120000, -15000, -4800])
    expect(s.rows[0]).toMatchObject({
      description: "PIX QR CODE DINAMICO",
      externalId: "1000001",
      balanceAfter: 100000,
    })
  })

  it("OFX que diz CHARSET 1252 mas vem em UTF-8 (Nubank) mantém os acentos", () => {
    const s = parseStatement(
      bytes(OCT_INVOICE.replace("Posto Exemplo</MEMO>", "Pix no Crédito - Júlia</MEMO>")),
    )
    expect(s.rows.map((r) => r.description)).toContain("Pix no Crédito - Júlia")
  })

  it("arquivo desconhecido vira erro claro", () => {
    expect(() => parseStatement(bytes("qualquer coisa"))).toThrow(StatementParseError)
  })
})

describe("descrições", () => {
  it("parcela, IOF, estorno e pagamento de fatura", () => {
    expect(parseInstallment("Loja Moda - Parcela 3/10")).toEqual({
      base: "Loja Moda",
      number: 3,
      total: 10,
    })
    expect(parseInstallment("Loja - Parcela 11/10")).toBeNull()
    expect(referencedMerchant('IOF de "Servico Nuvem Inc."')).toBe("Servico Nuvem Inc.")
    expect(rowKind({ description: "Pagamento recebido", amount: 90000 }, true)).toBe("card_payment")
    expect(rowKind({ description: 'Estorno de "Posto"', amount: 100 }, true)).toBe("refund")
    expect(rowKind({ description: 'IOF de "X"', amount: -100 }, true)).toBe("iof")
    expect(rowKind({ description: "PIX ENVIADO", amount: -100 }, false)).toBe("other")
  })

  it("chave do estabelecimento ignora números, parcela e prefixos de IOF/estorno", () => {
    expect(merchantKey("IFD*IFOOD.COM AGENCIA 123456")).toBe(
      merchantKey("IFD*IFOOD.COM AGENCIA 999999"),
    )
    expect(merchantKey("Loja Moda - Parcela 3/10")).toBe("LOJA MODA")
    expect(merchantKey('Estorno de "Posto Exemplo"')).toBe(merchantKey("Posto Exemplo"))
  })

  it("identidade de cada linha: FITID repetido (IOF) e compras iguais no mesmo dia não colidem", () => {
    const rows = parseStatement(bytes(OCT_INVOICE)).rows
    const prints = fingerprints(rows)
    expect(new Set(prints).size).toBe(rows.length)
    // Mesmo arquivo de novo → mesmas identidades (reimportar não duplica).
    expect(fingerprints(parseStatement(bytes(OCT_INVOICE)).rows)).toEqual(prints)
    const twin = [rows[2]!, { ...rows[2]! }]
    expect(new Set(fingerprints(twin)).size).toBe(2)
  })

  it("a parcela futura tem a mesma identidade quando a fatura real chegar", () => {
    const [future] = fingerprints(parseStatement(bytes(FEB_INVOICE)).rows)
    expect(fingerprints(parseStatement(bytes(FEB_INVOICE)).rows)[0]).toBe(future)
  })
})

describe("regras", () => {
  const base = { accountId: null, minAmount: null, maxAmount: null, sign: null, enabled: true }
  it("contém, igual, regex, sinal e faixa de valor", () => {
    const tx = { description: "IFD*IFOOD.COM AGENCIA 123", accountId: "a", amount: -5000 }
    expect(ruleMatches({ ...base, matchType: "contains", pattern: "ifood" }, tx)).toBe(true)
    expect(
      ruleMatches({ ...base, matchType: "contains", pattern: "IFD IFOOD.COM AGENCIA" }, tx),
    ).toBe(true)
    expect(ruleMatches({ ...base, matchType: "equals", pattern: "ifood" }, tx)).toBe(false)
    expect(ruleMatches({ ...base, matchType: "regex", pattern: "^IFD" }, tx)).toBe(true)
    expect(ruleMatches({ ...base, matchType: "contains", pattern: "ifood", sign: 1 }, tx)).toBe(
      false,
    )
    expect(
      ruleMatches({ ...base, matchType: "contains", pattern: "ifood", maxAmount: 1000 }, tx),
    ).toBe(false)
    expect(ruleMatches({ ...base, matchType: "regex", pattern: "([" }, tx)).toBe(false)
  })

  it("vence a de maior prioridade", () => {
    const tx = { description: "AMAZON BR", accountId: "a", amount: -100 }
    const rules = [
      {
        ...base,
        id: "1",
        matchType: "contains" as const,
        pattern: "AMAZON",
        priority: 0,
        createdAt: new Date(1),
      },
      {
        ...base,
        id: "2",
        matchType: "contains" as const,
        pattern: "AMAZON",
        priority: 5,
        createdAt: new Date(2),
      },
    ]
    expect(firstMatchingRule(rules, tx)?.id).toBe("2")
  })
})

describe("lançamento rápido", () => {
  const ctx = {
    today: "2026-10-28",
    accounts: [
      { id: "bra", name: "Bradesco", institution: "bradesco", type: "checking" },
      { id: "nuc", name: "Nubank conta", institution: "nubank", type: "checking" },
      { id: "card", name: "Nubank cartão", institution: "nubank", type: "credit_card" },
    ],
    categories: [
      { id: "ali", name: "Alimentação", kind: "expense" as const },
      { id: "sal", name: "Salários", kind: "income" as const },
    ],
  }
  it("50 feira bradesco ontem", () => {
    expect(parseQuick("50 feira bradesco ontem", ctx)).toEqual({
      description: "Feira",
      amount: 5000,
      direction: "out",
      date: "2026-10-27",
      accountId: "bra",
      categoryId: "ali",
    })
  })
  it("valor com centavos, cartão e dia do mês", () => {
    expect(parseQuick("12,50 padaria no cartão dia 3", ctx)).toMatchObject({
      amount: 1250,
      accountId: "card",
      date: "2026-10-03",
    })
  })
  it("entrada", () => {
    expect(parseQuick("recebi 8.200 salário nu conta", ctx)).toMatchObject({
      amount: 820000,
      direction: "in",
      accountId: "nuc",
      categoryId: "sal",
    })
  })
})

describe("mês do cartão (F81)", () => {
  const cycle = { closingDay: 3, dueDay: 11, invoices: [] }

  it("conta no mês em que a fatura vence: fecha dia 3, melhor dia 4, vence dia 11", () => {
    expect(cardMonth("2026-10-03", cycle)).toBe("2026-10")
    expect(cardMonth("2026-10-04", cycle)).toBe("2026-11")
    expect(cardMonth("2026-10-31", cycle)).toBe("2026-11")
    expect(cardMonth("2026-12-15", cycle)).toBe("2027-01")
  })

  it("vencimento antes do fechamento empurra mais um mês", () => {
    expect(cardMonth("2026-10-10", { closingDay: 25, dueDay: 5, invoices: [] })).toBe("2026-11")
    expect(cardMonth("2026-10-26", { closingDay: 25, dueDay: 5, invoices: [] })).toBe("2026-12")
  })

  it("fatura conhecida manda (o banco desloca o fechamento)", () => {
    const shifted = {
      ...cycle,
      invoices: [{ closingDate: "2026-11-05", referenceMonth: "2026-11-01" }],
    }
    expect(cardMonth("2026-11-04", shifted)).toBe("2026-11")
    expect(cardMonth("2026-11-06", shifted)).toBe("2026-12")
  })

  it("sem dia de fechamento, vale a data", () => {
    expect(cardMonth("2026-10-20", { closingDay: null, dueDay: null, invoices: [] })).toBe(
      "2026-10",
    )
  })
})

describe("contas do mês", () => {
  const cats = new Map<string, CategoryLite>([
    ["mor", { id: "mor", name: "Moradia", kind: "expense", nature: "fixed" }],
    ["ali", { id: "ali", name: "Alimentação", kind: "expense", nature: "variable" }],
    ["sal", { id: "sal", name: "Salários", kind: "income", nature: "fixed" }],
  ])
  const tx = (o: Partial<TxLite>): TxLite => {
    const date = o.date ?? "2026-10-10"
    return {
      id: Math.random().toString(36),
      accountId: "bra",
      date,
      month: date.slice(0, 7),
      deferredMonth: o.deferredFrom ? o.deferredFrom.slice(0, 7) : null,
      invoiceDue: null,
      amount: -1000,
      class: "normal",
      categoryId: null,
      nature: null,
      status: "confirmed",
      splits: null,
      recurringId: null,
      recurringPeriod: null,
      deferredFrom: null,
      manual: false,
      ...o,
    }
  }

  it("totais, previstas, estorno reduzindo despesa, transferência fora e livre por dia", () => {
    const txs = [
      tx({ amount: 1_000_000, categoryId: "sal" }),
      tx({ amount: -250_000, categoryId: "mor" }),
      tx({ amount: -30_000, categoryId: "ali" }),
      tx({ amount: 5_000, categoryId: "ali" }), // estorno
      tx({ amount: -12_000, categoryId: "mor", status: "planned", date: "2026-10-29" }),
      tx({ amount: -90_000, class: "transfer" }),
      tx({
        amount: -7_000,
        splits: [
          { categoryId: "ali", amount: -5_000 },
          { categoryId: "mor", amount: -2_000 },
        ],
      }),
    ]
    const t = monthTotals(txs, cats, { month: "2026-10", today: "2026-10-28", goal: 500_000 })
    expect(t.incomeRealized).toBe(1_000_000)
    expect(t.expenseRealized).toBe(250_000 + 30_000 - 5_000 + 7_000)
    expect(t.expensePlanned).toBe(12_000)
    expect(t.fixedExpense).toBe(250_000 + 12_000 + 2_000)
    expect(t.surplus).toBe(1_000_000 - 282_000 - 12_000)
    expect(t.daysLeft).toBe(4)
    expect(t.freePerDay).toBe(Math.floor((706_000 - 500_000) / 4))
  })

  it("compra no cartão aparece no mês mas soma pela fatura que vence (F81)", () => {
    const txs = [
      tx({ amount: 1_000_000, categoryId: "sal" }),
      tx({ amount: -40_000, categoryId: "ali", accountId: "card", invoiceDue: "2026-11-11" }),
    ]
    const oct = monthTotals(txs, cats, { month: "2026-10", today: "2026-10-28", goal: 0 })
    expect(oct.expenseRealized + oct.expensePlanned).toBe(0)
    const nov = monthTotals([], cats, {
      month: "2026-11",
      today: "2026-10-28",
      goal: 0,
      bills: [{ amount: 40_000, paid: false }],
    })
    expect(nov.expensePlanned).toBe(40_000)
    expect(nov.variableExpense).toBe(40_000)
    expect(rowFlag(txs[1]!, "2026-10", "2026-10-28")).toBe("in_invoice")
    // Nos gastos por categoria, a compra continua no mês dela.
    expect(categoryBreakdown(txs, [], cats, "2026-10")).toEqual([
      { categoryId: "ali", amount: 40_000, average: null },
    ])
  })

  it("selos: adiada, paga com atraso, adiantada, vencida, vence hoje", () => {
    const deferred = tx({
      status: "planned",
      date: "2026-11-05",
      deferredFrom: "2026-10-05",
      recurringPeriod: "2026-10-01",
      recurringId: "r",
    })
    expect(rowFlag(deferred, "2026-10", "2026-10-28")).toBe("deferred_out")
    expect(rowFlag(deferred, "2026-11", "2026-10-28")).toBe("deferred_in")
    expect(rowFlag({ ...deferred, status: "confirmed" }, "2026-11", "2026-10-28")).toBe("paid_late")
    expect(
      rowFlag(
        tx({ recurringId: "r", recurringPeriod: "2026-11-01", date: "2026-10-28" }),
        "2026-10",
        "2026-10-28",
      ),
    ).toBe("paid_early")
    expect(rowFlag(tx({ status: "planned", date: "2026-10-20" }), "2026-10", "2026-10-28")).toBe(
      "overdue",
    )
    expect(rowFlag(tx({ status: "planned", date: "2026-10-28" }), "2026-10", "2026-10-28")).toBe(
      "due_today",
    )
  })

  it("categorias com média dos meses anteriores e 'sem categoria' por último", () => {
    const month = [
      tx({ amount: -30_000, categoryId: "ali" }),
      tx({ amount: -1_000 }),
      tx({ amount: -50_000, categoryId: "mor" }),
    ]
    const history = [
      tx({ date: "2026-09-10", amount: -20_000, categoryId: "ali" }),
      tx({ date: "2026-08-10", amount: -40_000, categoryId: "ali" }),
    ]
    expect(categoryBreakdown(month, history, cats, "2026-10")).toEqual([
      { categoryId: "mor", amount: 50_000, average: 0 },
      { categoryId: "ali", amount: 30_000, average: 30_000 },
      { categoryId: null, amount: 1_000, average: null },
    ])
  })

  it("cobertura dos extratos: completo, pendente, em aberto e futuro", () => {
    const now = "2026-10-28"
    expect(monthCoverage([{ start: "2026-08-31", end: "2026-10-28" }], "2026-09", now)).toEqual({
      status: "done",
      coveredUntil: "2026-09-30",
    })
    expect(monthCoverage([{ start: "2026-09-01", end: "2026-09-15" }], "2026-09", now)).toEqual({
      status: "pending",
      coveredUntil: "2026-09-15",
    })
    expect(
      monthCoverage(
        [
          { start: "2026-09-04", end: "2026-10-03" },
          { start: "2026-10-04", end: "2026-10-28" },
        ],
        "2026-10",
        now,
      ),
    ).toEqual({ status: "open", coveredUntil: "2026-10-28" })
    expect(monthCoverage([], "2026-11", now).status).toBe("future")
    // Buraco no começo do mês: não conta como coberto.
    expect(monthCoverage([{ start: "2026-09-05", end: "2026-09-30" }], "2026-09", now)).toEqual({
      status: "pending",
      coveredUntil: null,
    })
  })
})
