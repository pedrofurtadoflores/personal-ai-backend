/**
 * Carga inicial do Financeiro pela API (mesma lógica do app): contas, categorias, meta, bens,
 * regras, contas fixas, extratos e ajustes por lançamento. Os dados ficam num arquivo JSON fora
 * do git (ver financeiro.md). Rodar de novo não duplica nada.
 *
 *   FINANCE_API_URL=https://... FINANCE_PASSWORD=... npm run finance:seed -- ../financeiro-carga.json
 *
 * Valores no JSON em reais (ex.: 4710.25); a API trabalha em centavos.
 */
import { readFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

type Seed = {
  since?: string
  extratosDir?: string
  settings?: { monthlySavingGoal?: number }
  accounts: {
    key: string
    name: string
    type: "checking" | "credit_card" | "cash" | "other"
    institution?: "nubank" | "bradesco" | "other"
    holder?: string
    closingDay?: number
    dueDay?: number
    openingBalance?: number
    openingDate?: string
    /** false = conta só de repasse, sem extrato (F78). */
    trackBalance?: boolean
  }[]
  categories?: "defaults" | string[]
  /** Categorias além das padrão (pelo nome). */
  extraCategories?: { name: string; kind?: "income" | "expense"; nature?: "fixed" | "variable" }[]
  rules?: {
    pattern: string
    matchType?: "contains" | "equals" | "regex"
    category?: string
    action?: "categorize" | "ask" | "transfer"
    renameTo?: string
    nature?: "fixed" | "variable"
    priority?: number
    account?: string
  }[]
  recurring?: {
    name: string
    direction: "in" | "out"
    dayOfMonth: number
    expectedAmount: number
    account: string
    category?: string
    matchPattern?: string
    tolerancePct?: number
    /** "AAAA-MM": primeiro mês em que vale. */
    from?: string
    /** "AAAA-MM": último mês em que vale (ex.: empréstimo, ou só um mês para férias e 13º). */
    until?: string
  }[]
  assets?: {
    name: string
    type?: "vehicle" | "real_estate" | "investment" | "other"
    value: number
    source?: string
  }[]
  /** Contas sem data (F76): valor estimado em reais, opcional. */
  pending?: { name: string; estimate?: number; category?: string; notes?: string }[]
  files?: { file: string; account: string }[]
  /** Lançamentos avulsos sem extrato (ex.: meses passados de uma conta só de repasse). */
  transactions?: {
    account: string
    date: string
    amount: number
    description: string
    category?: string
    notes?: string
  }[]
  /** Padrões de sugestões de regra da IA para recusar. */
  dismissSuggestions?: string[]
  overrides?: {
    account: string
    date: string
    amount: number
    match: string
    category?: string
    transfer?: boolean
    description?: string
    notes?: string
  }[]
}

const API = (process.env.FINANCE_API_URL ?? "http://localhost:3333").replace(/\/$/, "")
const PASSWORD = process.env.FINANCE_PASSWORD
const seedPath = process.argv[2]
if (!seedPath || !PASSWORD) {
  console.error(
    "Uso: FINANCE_API_URL=... FINANCE_PASSWORD=... npm run finance:seed -- <carga.json>",
  )
  process.exit(1)
}
const seed = JSON.parse(readFileSync(seedPath, "utf8")) as Seed
const baseDir = resolve(dirname(seedPath), seed.extratosDir ?? ".")
const cents = (reais: number) => Math.round(reais * 100)

let token = ""
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string }
  if (!response.ok)
    throw new Error(
      `${method} ${path} → ${response.status} ${json.error ?? ""} ${json.message ?? ""}`,
    )
  return json
}

const login = await fetch(API + "/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: PASSWORD }),
})
if (!login.ok)
  throw new Error(`Login falhou (${login.status}). Confira FINANCE_API_URL e FINANCE_PASSWORD.`)
token = ((await login.json()) as { token: string }).token
console.log(`Conectado em ${API}`)

// Contas (pelo nome).
type Account = { id: string; name: string }
const accounts = new Map<string, string>()
const existingAccounts = (await call<{ accounts: Account[] }>("GET", "/finance/accounts")).accounts
for (const a of seed.accounts) {
  let id = existingAccounts.find((x) => x.name === a.name)?.id
  const body = {
    name: a.name,
    type: a.type,
    institution: a.institution ?? "other",
    holder: a.holder ?? null,
    closingDay: a.closingDay ?? null,
    dueDay: a.dueDay ?? null,
    ...(a.trackBalance !== undefined ? { trackBalance: a.trackBalance } : {}),
    ...(a.openingDate
      ? { openingDate: a.openingDate, openingBalance: cents(a.openingBalance ?? 0) }
      : {}),
  }
  if (!id) id = (await call<Account>("POST", "/finance/accounts", body)).id
  accounts.set(a.key, id)
}
console.log(`Contas: ${seed.accounts.map((a) => a.name).join(", ")}`)

// Categorias e meta.
type Category = { id: string; name: string }
const categories =
  seed.categories === "defaults" || !seed.categories
    ? (await call<{ categories: Category[] }>("POST", "/finance/categories/defaults", {}))
        .categories
    : (
        await call<{ categories: Category[] }>("POST", "/finance/categories/defaults", {
          names: seed.categories,
        })
      ).categories
for (const extra of seed.extraCategories ?? []) {
  if (categories.some((c) => c.name.toLowerCase() === extra.name.toLowerCase())) continue
  categories.push(
    await call<Category>("POST", "/finance/categories", {
      name: extra.name,
      kind: extra.kind ?? "expense",
      nature: extra.nature ?? "variable",
    }),
  )
}
const categoryId = (name?: string) => {
  if (!name) return null
  const found = categories.find((c) => c.name.toLowerCase() === name.toLowerCase())
  if (!found) throw new Error(`Categoria "${name}" não existe.`)
  return found.id
}
const accountId = (key: string) => {
  const id = accounts.get(key)
  if (!id) throw new Error(`Conta "${key}" não está em accounts.`)
  return id
}
if (seed.settings?.monthlySavingGoal !== undefined) {
  await call("PATCH", "/finance/settings", {
    monthlySavingGoal: cents(seed.settings.monthlySavingGoal),
  })
}
console.log(`Categorias: ${categories.length}`)

// Bens (pelo nome).
const netWorth = await call<{ assets: { name: string }[] }>("GET", "/finance/net-worth")
for (const asset of seed.assets ?? []) {
  if (netWorth.assets.some((x) => x.name === asset.name)) continue
  await call("POST", "/finance/assets", {
    name: asset.name,
    type: asset.type ?? "other",
    value: cents(asset.value),
    source: asset.source ?? null,
  })
}

// Regras (pelo padrão), antes dos extratos para já categorizarem na importação.
const existingRules = (await call<{ rules: { pattern: string }[] }>("GET", "/finance/rules")).rules
let newRules = 0
for (const rule of seed.rules ?? []) {
  // A API guarda o padrão sem espaços nas pontas.
  const pattern = rule.pattern.trim().toUpperCase()
  if (existingRules.some((r) => r.pattern.trim().toUpperCase() === pattern)) continue
  await call("POST", "/finance/rules", {
    pattern: rule.pattern,
    matchType: rule.matchType ?? "contains",
    action: rule.action ?? "categorize",
    categoryId: categoryId(rule.category),
    renameTo: rule.renameTo ?? null,
    nature: rule.nature ?? null,
    priority: rule.priority ?? 0,
    accountId: rule.account ? accountId(rule.account) : null,
  })
  newRules++
}
console.log(`Regras novas: ${newRules}`)

// Contas fixas (pelo nome), antes dos extratos para o lançamento real casar com a prevista.
const lastDayOf = (month: string) => {
  const d = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)
  return `${month}-${String(d.getDate()).padStart(2, "0")}`
}
for (const rec of seed.recurring ?? []) {
  // Já cadastrada? Confere no planejamento do primeiro mês dela.
  const query = rec.from ? `?month=${rec.from}` : ""
  const planning = await call<{ recurring: { name: string }[] }>("GET", `/finance/planning${query}`)
  if (planning.recurring.some((r) => r.name === rec.name)) continue
  await call("POST", "/finance/recurring", {
    name: rec.name,
    direction: rec.direction,
    dayOfMonth: rec.dayOfMonth,
    expectedAmount: cents(rec.expectedAmount),
    accountId: accountId(rec.account),
    categoryId: categoryId(rec.category),
    matchPattern: rec.matchPattern ?? null,
    ...(rec.tolerancePct !== undefined ? { tolerancePct: rec.tolerancePct } : {}),
    ...(rec.from ? { startsOn: `${rec.from}-01` } : {}),
    ...(rec.until ? { endsOn: lastDayOf(rec.until) } : {}),
  })
}
console.log(`Contas fixas: ${(seed.recurring ?? []).length}`)

// Contas sem data (pelo nome).
const openPending = (await call<{ items: { name: string }[] }>("GET", "/finance/pending")).items
for (const item of seed.pending ?? []) {
  if (openPending.some((p) => p.name === item.name)) continue
  await call("POST", "/finance/pending", {
    name: item.name,
    estimate: item.estimate !== undefined ? cents(item.estimate) : null,
    categoryId: categoryId(item.category),
    notes: item.notes ?? null,
  })
}
console.log(`Contas sem data: ${(seed.pending ?? []).length}`)

// Extratos.
for (const f of seed.files ?? []) {
  const form = new FormData()
  form.append("file", new Blob([readFileSync(resolve(baseDir, f.file))]), basename(f.file))
  const query = new URLSearchParams({
    accountId: accountId(f.account),
    ...(seed.since ? { since: seed.since } : {}),
  })
  const response = await fetch(`${API}/finance/imports?${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })
  const body = (await response.json()) as {
    counts?: Record<string, number>
    balanceCheck?: { bank: number; computed: number } | null
    message?: string
  }
  if (!response.ok) throw new Error(`Importar ${f.file} → ${response.status} ${body.message ?? ""}`)
  const c = body.counts ?? {}
  const check = body.balanceCheck
    ? ` · saldo banco ${(body.balanceCheck.bank / 100).toFixed(2)} × calculado ${(body.balanceCheck.computed / 100).toFixed(2)}`
    : ""
  console.log(
    `  ${f.file}: ${c.inserted ?? 0} novas, ${c.duplicates ?? 0} já existiam, ${c.merged ?? 0} juntadas, ${c.rules ?? 0} por regra, ${c.transfers ?? 0} transferências, ${c.review ?? 0} para revisar${check}`,
  )
}

type Tx = {
  id: string
  accountId: string
  date: string
  amount: number
  originalDescription: string | null
  description: string
}
const transactionsOn = async (date: string, account: string) =>
  (
    await call<{ transactions: Tx[] }>(
      "GET",
      `/finance/transactions?from=${date}&to=${date}&accountId=${accountId(account)}`,
    )
  ).transactions

// Lançamentos avulsos (pela data, valor e descrição).
let newManual = 0
for (const t of seed.transactions ?? []) {
  const existing = await transactionsOn(t.date, t.account)
  if (existing.some((x) => x.amount === cents(t.amount) && x.description === t.description))
    continue
  await call("POST", "/finance/transactions", {
    accountId: accountId(t.account),
    date: t.date,
    amount: cents(t.amount),
    description: t.description,
    categoryId: categoryId(t.category),
    notes: t.notes ?? null,
  })
  newManual++
}
if (seed.transactions?.length) console.log(`Lançamentos avulsos novos: ${newManual}`)

// Ajustes por lançamento (o que regra nenhuma resolve).
let applied = 0
const missing: string[] = []
for (const o of seed.overrides ?? []) {
  const tx = (await transactionsOn(o.date, o.account)).find(
    (t) =>
      t.amount === cents(o.amount) &&
      (t.originalDescription ?? t.description).toLowerCase().includes(o.match.toLowerCase()),
  )
  if (!tx) {
    missing.push(`${o.date} ${o.amount} ${o.match}`)
    continue
  }
  await call("PATCH", `/finance/transactions/${tx.id}`, {
    ...(o.transfer ? { class: "transfer", categoryId: null } : {}),
    ...(o.category ? { categoryId: categoryId(o.category) } : {}),
    ...(o.description ? { description: o.description } : {}),
    ...(o.notes ? { notes: o.notes } : {}),
  })
  applied++
}
console.log(
  `Ajustes aplicados: ${applied}${missing.length ? ` · não encontrados: ${missing.join("; ")}` : ""}`,
)

// Sugestões de regra recusadas (textos genéricos que categorizariam errado).
const dismiss = new Set((seed.dismissSuggestions ?? []).map((p) => p.trim().toUpperCase()))
let review = await call<{ items: unknown[]; ruleSuggestions: { id: string; pattern: string }[] }>(
  "GET",
  "/finance/review",
)
let dismissed = 0
for (const s of review.ruleSuggestions) {
  if (!dismiss.has(s.pattern.trim().toUpperCase())) continue
  await call("POST", `/finance/rule-suggestions/${s.id}/dismiss`, {})
  dismissed++
}
if (dismissed) {
  console.log(`Sugestões recusadas: ${dismissed}`)
  review = await call("GET", "/finance/review")
}
console.log(
  `Pronto. Para revisar no app: ${review.items.length} lançamentos` +
    (review.ruleSuggestions.length ? ` e ${review.ruleSuggestions.length} sugestões.` : "."),
)
