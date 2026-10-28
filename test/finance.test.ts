import { and, eq, isNull } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { buildApp } from "../src/app.js"
import { db } from "../src/db/client.js"
import { finAccounts, finInvoices, finTransactions } from "../src/db/schema.js"
import { runJobNow } from "../src/lib/jobs.js"
import { setOpenAIClient } from "../src/lib/openai.js"
import { BRADESCO_CSV, FEB_INVOICE, nubankInvoiceOfx, OCT_INVOICE } from "./finance-fixtures.js"
import { FakeOpenAI, resetData } from "./fakes.js"
import { bearer, loginToken } from "./helpers.js"

// "Hoje" fixo: as regras de previstas, vencidas e cobertura dependem da data.
vi.useFakeTimers({ toFake: ["Date"] })
vi.setSystemTime(new Date("2026-10-28T15:00:00Z"))

const app = await buildApp()
const fake = new FakeOpenAI()
let auth: Record<string, string>
const ids = { bra: "", card: "", nuc: "" }
const cat: Record<string, string> = {}

beforeAll(async () => {
  await app.ready()
  await resetData()
  setOpenAIClient(fake.asClient())
  auth = bearer(await loginToken(app))
})
afterAll(async () => {
  setOpenAIClient(undefined)
  vi.useRealTimers()
  await app.close()
})

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
async function api<T = Record<string, unknown>>(method: Method, url: string, payload?: unknown) {
  const response = await app.inject({
    method,
    url,
    headers: auth,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  })
  return { status: response.statusCode, body: response.json<T>() }
}

async function upload(fileName: string, content: string, accountId?: string) {
  const boundary = "----financeiro-teste"
  const payload =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`
  const response = await app.inject({
    method: "POST",
    url: `/finance/imports${accountId ? `?accountId=${accountId}` : ""}`,
    headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  })
  return { status: response.statusCode, body: response.json() }
}

const txsOf = (accountId: string) =>
  db
    .select()
    .from(finTransactions)
    .where(and(eq(finTransactions.accountId, accountId), isNull(finTransactions.deletedAt)))

describe("configuração", () => {
  it("cria as contas e as categorias sugeridas", async () => {
    const mk = async (body: object) =>
      (await api<{ id: string }>("POST", "/finance/accounts", body)).body.id
    ids.bra = await mk({
      name: "Bradesco",
      type: "checking",
      institution: "bradesco",
      holder: "Pedro",
    })
    ids.card = await mk({
      name: "Nubank cartão",
      type: "credit_card",
      institution: "nubank",
      holder: "Ana",
    })
    ids.nuc = await mk({
      name: "Nubank conta",
      type: "checking",
      institution: "nubank",
      holder: "Ana",
    })
    const { body } = await api<{ categories: { id: string; name: string }[] }>(
      "POST",
      "/finance/categories/defaults",
      {},
    )
    expect(body.categories).toHaveLength(19)
    for (const c of body.categories) cat[c.name] = c.id
    // Nome repetido (sem diferenciar maiúsculas) não entra.
    expect(
      (await api("POST", "/finance/categories", { name: "moradia", kind: "expense" })).status,
    ).toBe(409)
  })
})

describe("fatura do cartão", () => {
  it("importa: transferência, IOF por regra, parcela com nota e o resto para revisar", async () => {
    const { status, body } = await upload("Nubank_2026-10-11.ofx", OCT_INVOICE)
    expect(status).toBe(201)
    expect(body).toMatchObject({
      accountId: ids.card,
      periodStart: "2026-09-04",
      periodEnd: "2026-10-03",
    })
    expect(body.counts).toMatchObject({
      read: 9,
      inserted: 9,
      transfers: 1,
      rules: 1,
      review: 7,
      duplicates: 0,
    })

    const rows = await txsOf(ids.card)
    const iof = rows.find((r) => r.originalDescription?.startsWith("IOF"))!
    expect(iof).toMatchObject({
      categoryId: cat["Impostos e taxas"],
      status: "confirmed",
      merchant: "SERVICO NUVEM INC.",
    })
    const parcela = rows.find((r) => r.installmentNumber === 3)!
    expect(parcela).toMatchObject({
      description: "Loja Moda",
      installmentTotal: 10,
      notes: "Parcela 3 de 10",
    })
    expect(rows.find((r) => r.originalDescription === "Pagamento recebido")).toMatchObject({
      class: "transfer",
      status: "confirmed",
    })

    // Fatura criada e ciclo aprendido (fecha dia 3, vence dia 11).
    const [invoice] = await db.select().from(finInvoices).where(eq(finInvoices.accountId, ids.card))
    expect(invoice).toMatchObject({
      closingDate: "2026-10-03",
      dueDate: "2026-10-11",
      bestPurchaseDate: "2026-10-04",
      statementTotal: 48050,
    })
    const [account] = await db.select().from(finAccounts).where(eq(finAccounts.id, ids.card))
    expect(account).toMatchObject({ closingDay: 3, dueDay: 11 })
  })

  it("reimportar o mesmo arquivo não duplica nada", async () => {
    const { body } = await upload("de-novo.ofx", OCT_INVOICE)
    expect(body.counts).toMatchObject({ inserted: 0, duplicates: 9 })
    expect(await txsOf(ids.card)).toHaveLength(9)
  })

  it("fatura futura vira prevista e não marca o mês como coberto", async () => {
    const { body } = await upload("Nubank_2027-02-11.ofx", FEB_INVOICE)
    expect(body.counts).toMatchObject({ inserted: 1, future: 1 })
    expect(body).toMatchObject({ periodStart: null, periodEnd: null })
    const [future] = (await txsOf(ids.card)).filter((r) => r.date === "2027-01-20")
    expect(future).toMatchObject({ status: "planned", installmentNumber: 7 })
  })

  it("a parcela que era futura é promovida quando o banco manda o arquivo de novo", async () => {
    // Gerado em 01/10 com uma parcela de 15/10: ainda era futura (prevista).
    const early = nubankInvoiceOfx({
      start: "20261004",
      end: "20261104",
      server: "20261001",
      balance: "-80.00",
      rows: [["DEBIT", "20261015", "-80.00", "pp-1", "Curso Exemplo - Parcela 2/5"]],
    })
    expect((await upload("antes.ofx", early)).body.counts).toMatchObject({ future: 1 })
    const [planned] = (await txsOf(ids.card)).filter((r) => r.date === "2026-10-15")
    expect(planned!.status).toBe("planned")
    // O mesmo arquivo gerado hoje (28/10): a parcela já aconteceu.
    const { body } = await upload(
      "hoje.ofx",
      early.replace("<DTSERVER>20261001", "<DTSERVER>20261028"),
    )
    expect(body.counts).toMatchObject({ inserted: 0, promoted: 1 })
    const [promoted] = (await txsOf(ids.card)).filter((r) => r.date === "2026-10-15")
    expect(promoted!.status).not.toBe("planned")
  })

  it("arquivo de cartão numa conta corrente é recusado", async () => {
    const { status, body } = await upload("x.ofx", OCT_INVOICE, ids.bra)
    expect(status).toBe(400)
    expect(body.error).toBe("account_mismatch")
  })
})

describe("conta corrente", () => {
  it("lançamento manual e conta fixa antes do extrato", async () => {
    const manual = await api("POST", "/finance/transactions", {
      accountId: ids.bra,
      date: "2026-10-11",
      amount: -4800,
      description: "Feira",
      categoryId: cat["Alimentação"],
    })
    expect(manual.status).toBe(201)
    const rec = await api("POST", "/finance/recurring", {
      name: "Condomínio",
      direction: "out",
      dayOfMonth: 5,
      expectedAmount: 120000,
      accountId: ids.bra,
      categoryId: cat["Moradia"],
    })
    expect(rec.status).toBe(201)
    const occurrence = (await txsOf(ids.bra)).find((r) => r.recurringId && r.date === "2026-10-05")
    expect(occurrence).toMatchObject({ status: "planned", amount: -120000 })
  })

  it("extrato do Bradesco: junta com o manual e com a conta fixa, calcula o saldo inicial e confere", async () => {
    const { status, body } = await upload("bradesco.csv", BRADESCO_CSV)
    expect(status).toBe(201)
    expect(body.counts).toMatchObject({ read: 5, merged: 2, inserted: 3 })
    expect(body.balanceCheck).toEqual({ date: "2026-10-28", bank: 460200, computed: 460200 })
    const [account] = await db.select().from(finAccounts).where(eq(finAccounts.id, ids.bra))
    expect(account).toMatchObject({
      openingBalance: 100690,
      openingDate: "2026-09-30",
      bankBalance: 460200,
    })

    const rows = await txsOf(ids.bra)
    expect(rows.find((r) => r.description === "Feira")).toMatchObject({
      manual: false,
      originalDescription: "PIX ENVIADO",
      date: "2026-10-12",
      categoryId: cat["Alimentação"],
    })
    expect(rows.find((r) => r.recurringId && r.date === "2026-10-05")).toMatchObject({
      status: "confirmed",
      originalDescription: "PAGTO ELETRON COBRANCA",
    })
  })

  it("valor do banco não muda; descrição e notas mudam", async () => {
    const [bank] = (await txsOf(ids.bra)).filter(
      (r) => r.originalDescription === "PIX QR CODE DINAMICO",
    )
    expect((await api("PATCH", `/finance/transactions/${bank!.id}`, { amount: -100 })).status).toBe(
      409,
    )
    const ok = await api("PATCH", `/finance/transactions/${bank!.id}`, {
      description: "Padaria",
      notes: "pão de queijo",
    })
    expect(ok.status).toBe(200)
    const [after] = await db.select().from(finTransactions).where(eq(finTransactions.id, bank!.id))
    expect(after).toMatchObject({
      description: "Padaria",
      notes: "pão de queijo",
      originalDescription: "PIX QR CODE DINAMICO",
    })
  })
})

describe("categorização", () => {
  it("IA: aplica o que tem certeza e pergunta o resto", async () => {
    const review = (
      await api<{ items: { id: string; originalDescription: string }[] }>("GET", "/finance/review")
    ).body.items
    const nuvem = review.find((i) => i.originalDescription === "Servico Nuvem Inc.")!
    const amazon = review.find((i) => i.originalDescription.startsWith("Amazon"))!
    fake.parsed = [
      {
        items: [
          {
            id: nuvem.id,
            categoryId: cat["Assinaturas"],
            confidence: 0.95,
            alternatives: [],
            question: null,
          },
          {
            id: amazon.id,
            categoryId: null,
            confidence: 0.3,
            alternatives: [cat["Compras"], "inventada"],
            question: "Amazon vende de tudo. O que foi?",
          },
        ],
      },
    ]
    await runJobNow("finance.categorize")
    const rows = await txsOf(ids.card)
    expect(rows.find((r) => r.id === nuvem.id)).toMatchObject({
      status: "auto",
      categorySource: "ai",
      categoryId: cat["Assinaturas"],
    })
    expect(rows.find((r) => r.id === amazon.id)).toMatchObject({
      status: "review",
      aiQuestion: "Amazon vende de tudo. O que foi?",
      aiSuggestions: [cat["Compras"]],
    })
    // Quem a IA não respondeu também não volta para ela.
    expect(rows.filter((r) => r.status === "review" && !r.aiTriedAt)).toHaveLength(0)
  })

  it("revisar com 'aplicar às iguais' sugere uma regra; aceitar cria a regra", async () => {
    const review = (
      await api<{ items: { id: string; originalDescription: string; sameCount: number }[] }>(
        "GET",
        "/finance/review",
      )
    ).body.items
    const posto = review.find((i) => i.originalDescription === "Posto Exemplo")!
    expect(posto.sameCount).toBeGreaterThanOrEqual(2)
    const { body } = await api<{
      resolved: number
      suggestion: { id: string; pattern: string } | null
    }>("POST", `/finance/review/${posto.id}`, {
      categoryId: cat["Transporte"],
      applyToSame: true,
    })
    expect(body.resolved).toBeGreaterThanOrEqual(3)
    expect(body.suggestion?.pattern).toBe("POSTO EXEMPLO")
    const rule = await api<{ pattern: string; categoryId: string }>(
      "POST",
      `/finance/rule-suggestions/${body.suggestion!.id}/accept`,
    )
    expect(rule.body).toMatchObject({ pattern: "POSTO EXEMPLO", categoryId: cat["Transporte"] })

    // A próxima fatura já sai categorizada pela regra.
    const next = nubankInvoiceOfx({
      start: "20261004",
      end: "20261104",
      balance: "-60.00",
      rows: [["DEBIT", "20261020", "-60.00", "zzz-1", "Posto Exemplo"]],
    })
    const imported = await upload("nov.ofx", next)
    expect(imported.body.counts).toMatchObject({ rules: 1, review: 0 })
  })

  it("dividir exige soma igual ao valor", async () => {
    const [amazon] = (await txsOf(ids.card)).filter((r) =>
      r.originalDescription?.startsWith("Amazon"),
    )
    const bad = await api("PUT", `/finance/transactions/${amazon!.id}/splits`, {
      parts: [
        { categoryId: cat["Compras"], amount: -100 },
        { categoryId: cat["Pets"], amount: -100 },
      ],
    })
    expect(bad.status).toBe(400)
    const good = await api("PUT", `/finance/transactions/${amazon!.id}/splits`, {
      parts: [
        { categoryId: cat["Compras"], amount: -13322 },
        { categoryId: cat["Pets"], amount: -3000 },
      ],
    })
    expect(good.status).toBe(200)
    const [after] = await db
      .select()
      .from(finTransactions)
      .where(eq(finTransactions.id, amazon!.id))
    expect(after).toMatchObject({ status: "confirmed", categoryId: null })
  })
})

describe("contas fixas", () => {
  let internetId = ""
  it("adiar só uma ocorrência, desfazer e 'já paguei'", async () => {
    await api("POST", "/finance/recurring", {
      name: "Internet",
      direction: "out",
      dayOfMonth: 28,
      expectedAmount: 11990,
      accountId: ids.bra,
      categoryId: cat["Moradia"],
    })
    const oct = (await txsOf(ids.bra)).find(
      (r) => r.description === "Internet" && r.date === "2026-10-28",
    )!
    internetId = oct.id
    const nov = (await txsOf(ids.bra)).find(
      (r) => r.description === "Internet" && r.date === "2026-11-28",
    )
    expect(nov?.status).toBe("planned")

    expect(
      (
        await api("POST", `/finance/transactions/${oct.id}/defer`, {
          date: "2026-11-05",
          reason: "sem saldo",
        })
      ).status,
    ).toBe(200)
    const octView = (
      await api<{ flow: { expense: { id: string; flag: string }[] } }>(
        "GET",
        "/finance/overview?month=2026-10",
      )
    ).body
    expect(octView.flow.expense.find((t) => t.id === oct.id)?.flag).toBe("deferred_out")
    const novView = (
      await api<{ flow: { expense: { id: string; flag: string }[] } }>(
        "GET",
        "/finance/overview?month=2026-11",
      )
    ).body
    expect(novView.flow.expense.find((t) => t.id === oct.id)?.flag).toBe("deferred_in")
    // A de novembro continua prevista no dia 28.
    expect(
      (await db.select().from(finTransactions).where(eq(finTransactions.id, nov!.id)))[0],
    ).toMatchObject({ date: "2026-11-28", status: "planned" })

    expect((await api("POST", `/finance/transactions/${oct.id}/undefer`)).status).toBe(200)
    const paid = await api<{ operationId: string }>("POST", `/finance/transactions/${oct.id}/pay`, {
      date: "2026-10-28",
      amount: 12990,
    })
    expect(paid.status).toBe(200)
    expect(
      (await db.select().from(finTransactions).where(eq(finTransactions.id, oct.id)))[0],
    ).toMatchObject({ status: "confirmed", manual: true, amount: -12990 })

    // Desfazer a operação devolve a prevista.
    await api("POST", `/finance/operations/${paid.body.operationId}/undo`)
    expect(
      (await db.select().from(finTransactions).where(eq(finTransactions.id, oct.id)))[0],
    ).toMatchObject({ status: "planned", manual: false, amount: -11990 })
  })

  it("editar o cadastro muda só as previstas; encerrar tira os próximos meses", async () => {
    const { body } = await api<{ recurring: { id: string; name: string }[] }>(
      "GET",
      "/finance/planning?month=2026-10",
    )
    const internet = body.recurring.find((r) => r.name === "Internet")!
    await api("PATCH", `/finance/recurring/${internet.id}`, { expectedAmount: 13990 })
    expect(
      (await db.select().from(finTransactions).where(eq(finTransactions.id, internetId)))[0]!
        .amount,
    ).toBe(-13990)
    await api("DELETE", `/finance/recurring/${internet.id}`)
    const left = (await txsOf(ids.bra)).filter((r) => r.recurringId === internet.id)
    expect(left).toHaveLength(0)
  })
})

describe("telas", () => {
  it("visão geral: totais, categorias, fluxo e alertas", async () => {
    await api("PATCH", "/finance/settings", { monthlySavingGoal: 100000 })
    const { status, body } = await api<{
      totals: { incomeRealized: number; goal: number; daysLeft: number }
      categories: { categoryId: string | null }[]
      flow: { income: unknown[]; expense: { description: string }[] }
      alerts: { reviewCount: number; statementsUntil: string }
    }>("GET", "/finance/overview?month=2026-10")
    expect(status).toBe(200)
    expect(body.totals).toMatchObject({ incomeRealized: 500000, goal: 100000, daysLeft: 4 })
    expect(body.flow.expense.map((t) => t.description)).toContain("Feira")
    expect(body.categories.length).toBeGreaterThan(0)
    expect(body.alerts.statementsUntil).toBe("2026-10-28")
  })

  it("extratos por mês e conta", async () => {
    const { body } = await api<{
      months: {
        month: string
        accounts: {
          accountId: string
          status: string
          coveredUntil: string | null
          files: unknown[]
        }[]
      }[]
    }>("GET", "/finance/statements")
    const sep = body.months.find((m) => m.month === "2026-09")!
    expect(sep.accounts.find((a) => a.accountId === ids.card)).toMatchObject({
      status: "pending",
      coveredUntil: null,
    })
    const oct = body.months.find((m) => m.month === "2026-10")!
    expect(oct.accounts.find((a) => a.accountId === ids.bra)).toMatchObject({
      status: "open",
      coveredUntil: "2026-10-28",
    })
    expect(oct.accounts.find((a) => a.accountId === ids.nuc)).toMatchObject({
      status: "open",
      coveredUntil: null,
    })
  })

  it("planejamento: compras parceladas e compromissos", async () => {
    const { body } = await api<{
      installments: { description: string; total: number; remaining: number }[]
      commitments: unknown[]
    }>("GET", "/finance/planning")
    expect(body.installments.find((i) => i.description === "Loja Moda")).toMatchObject({
      total: 10,
    })
    expect(body.commitments).toHaveLength(6)
  })

  it("patrimônio: contas, bens, cartão e evolução", async () => {
    await api("POST", "/finance/assets", {
      name: "Carro",
      type: "vehicle",
      value: 5840000,
      source: "FIPE",
    })
    const { body } = await api<{
      checking: { accountId: string; balance: number | null }[]
      assets: { value: number }[]
      total: number
      series: unknown[]
    }>("GET", "/finance/net-worth")
    expect(body.checking.find((c) => c.accountId === ids.bra)?.balance).toBe(460200)
    expect(body.assets[0]?.value).toBe(5840000)
    expect(body.series).toHaveLength(6)
  })

  it("lançamento rápido entende o texto", async () => {
    const { body } = await api("POST", "/finance/quick-parse", { text: "50 feira bradesco ontem" })
    expect(body).toMatchObject({
      amount: 5000,
      accountId: ids.bra,
      categoryId: cat["Alimentação"],
      date: "2026-10-27",
    })
  })
})

describe("desfazer importação", () => {
  it("apaga as linhas novas e devolve as juntadas ao estado anterior", async () => {
    const { body } = await api<{
      months: { accounts: { accountId: string; files: { id: string; fileName: string }[] }[] }[]
    }>("GET", "/finance/statements")
    const batch = body.months
      .flatMap((m) => m.accounts)
      .flatMap((a) => a.files)
      .find((f) => f.fileName === "bradesco.csv")!
    expect((await api("POST", `/finance/imports/${batch.id}/undo`)).status).toBe(200)
    const rows = await txsOf(ids.bra)
    expect(rows.find((r) => r.description === "Feira")).toMatchObject({
      manual: true,
      fingerprint: null,
      date: "2026-10-11",
    })
    expect(rows.find((r) => r.recurringId && r.date === "2026-10-05")).toMatchObject({
      status: "planned",
      fingerprint: null,
    })
    expect(
      rows.filter((r) => r.originalDescription === "TED RECEBIDA EMPRESA EXEMPLO"),
    ).toHaveLength(0)
    expect((await api("POST", `/finance/imports/${batch.id}/undo`)).status).toBe(409)
  })
})

describe("ajustes vindos dos extratos reais", () => {
  it("corte por data, total da fatura do banco e PIX ligado ao pagamento do cartão", async () => {
    // Compras antes do corte ficam de fora, mas a fatura guarda o total do banco (F81).
    const old = nubankInvoiceOfx({
      start: "20260804",
      end: "20260904",
      balance: "-30.00",
      rows: [["DEBIT", "20260820", "-30.00", "old-inv-1", "Fatura antiga"]],
    })
    const skippedInvoice = await app.inject({
      method: "POST",
      url: "/finance/imports?since=2026-10-01",
      headers: { ...auth, "content-type": "multipart/form-data; boundary=b" },
      payload: `--b\r\nContent-Disposition: form-data; name="file"; filename="antiga.ofx"\r\n\r\n${old}\r\n--b--\r\n`,
    })
    expect(skippedInvoice.json().counts).toMatchObject({ skipped: 1, inserted: 0 })

    const card = nubankInvoiceOfx({
      start: "20261104",
      end: "20261204",
      balance: "-10.00",
      rows: [
        ["CREDIT", "20261025", "250.00", "pay-1", "Pagamento recebido"],
        ["DEBIT", "20260930", "-10.00", "old-1", "Antes do corte"],
      ],
    })
    const withSince = await app.inject({
      method: "POST",
      url: "/finance/imports?since=2026-10-01",
      headers: { ...auth, "content-type": "multipart/form-data; boundary=b" },
      payload: `--b\r\nContent-Disposition: form-data; name="file"; filename="corte2.ofx"\r\n\r\n${card}\r\n--b--\r\n`,
    })
    expect(withSince.json().counts).toMatchObject({ skipped: 1, inserted: 1, transfers: 1 })
    const [antiga] = await db
      .select()
      .from(finInvoices)
      .where(eq(finInvoices.referenceMonth, "2026-09-01"))
    expect(antiga?.statementTotal).toBe(3000)

    const csv = [
      "Data;Histórico;Docto.;Crédito (R$);Débito (R$);Saldo (R$)",
      "24/10/2026;PIX ENVIADO;2000001; ;250,00;4.352,00",
      "Os dados acima tem como base 28/10/2026 às 10:00;;;;;",
    ].join("\n")
    const bank = await upload("pix.csv", csv)
    expect(bank.body.counts).toMatchObject({ inserted: 1, transfers: 1, review: 0 })
    const [pix] = (await txsOf(ids.bra)).filter(
      (r) => r.date === "2026-10-24" && r.amount === -25000,
    )
    const [payment] = (await txsOf(ids.card)).filter(
      (r) => r.date === "2026-10-25" && r.amount === 25000,
    )
    expect(pix).toMatchObject({ class: "transfer", status: "confirmed" })
    expect(pix!.transferGroupId).toBeTruthy()
    expect(pix!.transferGroupId).toBe(payment!.transferGroupId)
  })
})

describe("contas sem data", () => {
  it("cria sem valor, agenda como prevista e volta para a lista se a prevista for apagada", async () => {
    const created = await api<{ id: string }>("POST", "/finance/pending", {
      name: "Arrumar o para-choque",
      categoryId: cat["Transporte"],
    })
    expect(created.status).toBe(201)
    const id = created.body.id
    // Sem valor estimado, agendar exige o valor.
    expect(
      (
        await api("POST", `/finance/pending/${id}/schedule`, {
          date: "2026-12-10",
          accountId: ids.bra,
        })
      ).status,
    ).toBe(400)
    await api("PATCH", `/finance/pending/${id}`, { estimate: 120000 })
    const scheduled = await api<{ transactionId: string }>(
      "POST",
      `/finance/pending/${id}/schedule`,
      {
        date: "2026-12-10",
        accountId: ids.bra,
      },
    )
    expect(scheduled.status).toBe(200)
    const [tx] = await db
      .select()
      .from(finTransactions)
      .where(eq(finTransactions.id, scheduled.body.transactionId))
    expect(tx).toMatchObject({
      status: "planned",
      amount: -120000,
      categoryId: cat["Transporte"],
      manual: false,
    })
    expect((await api<{ items: unknown[] }>("GET", "/finance/pending")).body.items).toHaveLength(0)

    // Apagou a prevista: a conta volta para "sem data".
    await api("DELETE", `/finance/transactions/${scheduled.body.transactionId}`)
    const back = (await api<{ items: { id: string }[] }>("GET", "/finance/pending")).body.items
    expect(back.map((i) => i.id)).toContain(id)
  })

  it("já paguei vira lançamento manual; tirar da lista some de vez", async () => {
    const { body } = await api<{ id: string }>("POST", "/finance/pending", {
      name: "Presente",
      estimate: 15000,
    })
    const paid = await api<{ transactionId: string }>(
      "POST",
      `/finance/pending/${body.id}/schedule`,
      {
        date: "2026-10-28",
        accountId: ids.bra,
        paid: true,
      },
    )
    const [tx] = await db
      .select()
      .from(finTransactions)
      .where(eq(finTransactions.id, paid.body.transactionId))
    expect(tx).toMatchObject({ status: "review", manual: true, amount: -15000 })
    const other = await api<{ id: string }>("POST", "/finance/pending", { name: "Curso" })
    await api("DELETE", `/finance/pending/${other.body.id}`)
    const items = (await api<{ items: { id: string }[] }>("GET", "/finance/pending")).body.items
    expect(items.map((i) => i.id)).not.toContain(other.body.id)
    expect(items.map((i) => i.id)).not.toContain(body.id)
  })
})

describe("conta só de repasse", () => {
  it("fica fora do patrimônio e dos extratos, e a prevista se confirma sozinha na data", async () => {
    await api("PATCH", `/finance/accounts/${ids.nuc}`, { trackBalance: false })
    await api("POST", "/finance/recurring", {
      name: "Salário Ana",
      direction: "in",
      dayOfMonth: 5,
      expectedAmount: 170000,
      accountId: ids.nuc,
      categoryId: cat["Salários"],
    })
    const overview = (
      await api<{ flow: { income: { description: string; status: string }[] } }>(
        "GET",
        "/finance/overview?month=2026-10",
      )
    ).body
    expect(overview.flow.income.find((t) => t.description === "Salário Ana")?.status).toBe(
      "confirmed",
    )
    const nw = (await api<{ checking: { accountId: string }[] }>("GET", "/finance/net-worth")).body
    expect(nw.checking.map((c) => c.accountId)).not.toContain(ids.nuc)
    const st = (
      await api<{ months: { accounts: { accountId: string }[] }[] }>("GET", "/finance/statements")
    ).body
    expect(st.months.flatMap((m) => m.accounts).map((a) => a.accountId)).not.toContain(ids.nuc)
  })

  it("conta corrente no fim do mês soma o repasse e desconta a fatura que vence (F82)", async () => {
    type Cash = {
      accountId: string
      balance: number
      planned: number
      passThrough: number
      cardDue: number
      bills: { accountId: string; dueDate: string; amount: number }[]
      projected: number
    } | null
    const get = async (month: string) =>
      (await api<{ cash: Cash }>("GET", `/finance/overview?month=${month}`)).body.cash
    // Mês que passou: o saldo real no último dia, sem previsão (F83).
    const sep = await get("2026-09")
    if (sep) expect(sep).toMatchObject({ planned: 0, cardDue: 0, projected: sep.balance })
    const nov = (await get("2026-11"))!
    expect(nov.accountId).toBe(ids.bra)
    expect(nov.passThrough).toBe(170000)
    expect(nov.bills.every((b) => b.accountId === ids.card && b.dueDate >= "2026-10-28")).toBe(true)
    expect(nov.cardDue).toBe(nov.bills.reduce((s, b) => s + b.amount, 0))
    expect(nov.projected).toBe(nov.balance + nov.planned + nov.passThrough - nov.cardDue)

    const { balances } = (
      await api<{ balances: { accountId: string; balance: number | null }[] }>(
        "GET",
        "/finance/overview?month=2026-11",
      )
    ).body
    expect(balances.find((b) => b.accountId === ids.bra)?.balance).toBe(nov.balance)
    expect(balances.find((b) => b.accountId === ids.nuc)?.balance).toBeNull()
    expect(balances.map((b) => b.accountId)).not.toContain(ids.card)
  })

  it("compras do cartão aparecem no mês, mas as saídas contam a fatura que vence (F81)", async () => {
    type Ov = {
      flow: { expense: { accountId: string; flag: string | null; invoiceDue: string | null }[] }
      bills: { accountId: string; dueDate: string; amount: number; paid: boolean }[]
      totals: { expenseRealized: number; expensePlanned: number }
    }
    const oct = (await api<Ov>("GET", "/finance/overview?month=2026-10")).body
    const card = oct.flow.expense.filter((t) => t.accountId === ids.card)
    expect(card.length).toBeGreaterThan(0)
    expect(card.every((t) => t.flag === "in_invoice" && t.invoiceDue)).toBe(true)
    for (const bill of oct.bills) {
      expect(bill.accountId).toBe(ids.card)
      expect(bill.dueDate.slice(0, 7)).toBe("2026-10")
    }
  })
})

describe("dívidas (F84)", () => {
  type Debt = { id: string; amount: number; paid: number; remaining: number; payments: unknown[] }
  const list = async () => (await api<{ items: Debt[] }>("GET", "/finance/debts")).body.items
  const owe = async () => (await api<{ debtsLeft: number }>("GET", "/finance/net-worth")).body

  it("pagamento livre abate, vira saída em Dívidas, desfazer devolve e quitar zera", async () => {
    const created = await api<{ id: string }>("POST", "/finance/debts", {
      name: "Empréstimo da mãe",
      amount: 100000,
      startedOn: "2026-10-01",
    })
    expect(created.status).toBe(201)
    const id = created.body.id
    expect((await owe()).debtsLeft).toBe(100000)

    const pay = await api<{ transactionId: string; operationId: string; remaining: number }>(
      "POST",
      `/finance/debts/${id}/payments`,
      { date: "2026-10-20", accountId: ids.bra, amount: 30000 },
    )
    expect(pay.body.remaining).toBe(70000)
    const [tx] = await db
      .select()
      .from(finTransactions)
      .where(eq(finTransactions.id, pay.body.transactionId))
    expect(tx).toMatchObject({ amount: -30000, description: "Pagamento: Empréstimo da mãe" })
    const cats = (
      await api<{ categories: { id: string; name: string }[] }>("GET", "/finance/categories")
    ).body.categories
    expect(cats.find((c) => c.id === tx!.categoryId)?.name).toBe("Dívidas")
    expect((await owe()).debtsLeft).toBe(70000)

    await api("POST", `/finance/operations/${pay.body.operationId}/undo`)
    expect((await list()).find((d) => d.id === id)).toMatchObject({ paid: 0, remaining: 100000 })

    await api("POST", `/finance/debts/${id}/payments`, {
      date: "2026-10-25",
      accountId: ids.bra,
      amount: 100000,
    })
    expect((await list()).find((d) => d.id === id)).toMatchObject({ remaining: 0 })
    expect((await owe()).debtsLeft).toBe(0)

    await api("DELETE", `/finance/debts/${id}`)
    expect((await list()).map((d) => d.id)).not.toContain(id)
  })
})
