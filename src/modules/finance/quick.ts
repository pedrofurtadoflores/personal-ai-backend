/**
 * Lançamento rápido (F35): "50 feira bradesco ontem" → formulário preenchido. Parser local,
 * sem IA; o que ele não entender fica em branco para o usuário completar.
 */
import { addDays } from "./dates.js"
import { normalizeText } from "./normalize.js"
import { parseMoney } from "./parse.js"

/** Palavra-chave → nome de categoria (casado sem acento com as categorias do usuário). */
const KEYWORDS: [RegExp, string][] = [
  [
    /\b(FEIRA|MERCADO|SACOLAO|HORTIFRUTI|SUPERMERCADO|ACOUGUE|PADARIA|PAO|IFOOD|LANCHE|PIZZA|RESTAURANTE|ALMOCO|JANTAR)\b/,
    "ALIMENTACAO",
  ],
  [/\b(UBER|99|TAXI|GASOLINA|POSTO|COMBUSTIVEL|ETANOL|ESTACIONAMENTO|PEDAGIO)\b/, "TRANSPORTE"],
  [/\b(FARMACIA|REMEDIO|DROGARIA|CONSULTA|MEDICO|EXAME)\b/, "SAUDE"],
  [/\b(RACAO|PET|VETERINARIO)\b/, "PETS"],
  [/\b(ALUGUEL|CONDOMINIO|LUZ|AGUA|GAS|INTERNET)\b/, "MORADIA"],
  [/\b(CINEMA|SHOW|JOGO|BAR|CERVEJA)\b/, "HOBBIES E LAZER"],
  [/\b(SALARIO)\b/, "SALARIOS"],
  [/\b(HORA EXTRA|HORAS EXTRAS|BONUS|13|FERIAS)\b/, "EXTRAS"],
]

export type QuickAccount = { id: string; name: string; institution: string; type: string }
export type QuickCategory = { id: string; name: string; kind: "income" | "expense" }

export type QuickResult = {
  description: string
  /** Centavos, sempre positivo; o sentido vem de `direction`. */
  amount: number | null
  direction: "in" | "out"
  date: string
  accountId: string | null
  categoryId: string | null
}

export function parseQuick(
  text: string,
  ctx: { today: string; accounts: QuickAccount[]; categories: QuickCategory[] },
): QuickResult {
  const n = normalizeText(text)
  let rest = ` ${n} `

  // Valor: "1.234,56", "12,50", "12.50" ou "50" (o primeiro número que não é dia).
  const money = rest.match(
    /(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?!\s*\/)/,
  )
  let amount: number | null = null
  if (money && !/DIA\s*$/.test(rest.slice(0, money.index))) {
    const raw = money[1]!
    // "8.200" é milhar; "12.50" é centavo (digitado com ponto).
    const normalized = /^\d{1,3}(\.\d{3})+$/.test(raw)
      ? raw.replace(/\./g, "")
      : /^\d+\.\d{1,2}$/.test(raw)
        ? raw.replace(".", ",")
        : raw
    amount = parseMoney(normalized)
    rest = rest.replace(money[0], " ")
  }

  let date = ctx.today
  const dayMatch = rest.match(/\bDIA (\d{1,2})\b/)
  if (/\bANTEONTEM\b/.test(rest)) date = addDays(ctx.today, -2)
  else if (/\bONTEM\b/.test(rest)) date = addDays(ctx.today, -1)
  else if (dayMatch) date = `${ctx.today.slice(0, 8)}${dayMatch[1]!.padStart(2, "0")}`
  rest = rest.replace(/\b(ANTEONTEM|ONTEM|HOJE|DIA \d{1,2})\b/g, " ")

  const direction = /\b(RECEBI|GANHEI|ENTRADA|SALARIO|REEMBOLSO)\b/.test(rest) ? "in" : "out"

  // Conta: "bradesco", "nu conta"/"nubank conta", "cartao"/"credito"/"nubank".
  let accountId: string | null = null
  const find = (pred: (a: QuickAccount) => boolean) => ctx.accounts.find(pred)?.id ?? null
  if (/\bBRADESCO\b/.test(rest)) accountId = find((a) => a.institution === "bradesco")
  else if (/\bNU(BANK)? CONTA\b|\bCONTA (DO )?NU(BANK)?\b/.test(rest))
    accountId = find((a) => a.institution === "nubank" && a.type === "checking")
  else if (/\b(CARTAO|CREDITO|NUBANK|NU)\b/.test(rest))
    accountId = find((a) => a.type === "credit_card") ?? find((a) => a.institution === "nubank")
  rest = rest.replace(
    /\b(BRADESCO|NUBANK|NU|CONTA|CARTAO|CREDITO|DO|DA|DE|NO|NA|EM|REAIS|LANCA|LANCAR|RECEBI|GANHEI|PAGUEI|GASTEI)\b/g,
    " ",
  )

  let categoryId: string | null = null
  for (const [re, name] of KEYWORDS) {
    if (!re.test(n)) continue
    const found = ctx.categories.find((c) => normalizeText(c.name) === name)
    if (found && found.kind === (direction === "in" ? "income" : "expense")) categoryId = found.id
    break
  }

  const words = rest.replace(/\s+/g, " ").trim().toLowerCase()
  const description = words ? words.charAt(0).toUpperCase() + words.slice(1) : ""
  return { description, amount, direction, date, accountId, categoryId }
}
