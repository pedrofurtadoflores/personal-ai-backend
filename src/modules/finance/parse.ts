/**
 * Leitura dos extratos (F07): OFX (conta ou cartão), CSV do Bradesco e CSV do Nubank.
 * Tudo vira um `ParsedStatement` único; nenhuma regra de negócio aqui.
 */
import { addDays } from "./dates.js"

export type StatementFormat =
  "ofx_card" | "ofx_bank" | "bradesco_csv" | "nubank_csv" | "nubank_card_csv"

export type ParsedRow = {
  date: string
  /** Centavos; negativo = saiu da conta / compra no cartão. */
  amount: number
  description: string
  externalId?: string
  /** Saldo da conta logo depois deste lançamento (CSV do Bradesco). */
  balanceAfter?: number
}

export type ParsedStatement = {
  format: StatementFormat
  institution: "nubank" | "bradesco" | "other"
  accountType: "checking" | "credit_card"
  /** Primeiro e último dia que o arquivo cobre (inclusive). */
  periodStart?: string
  periodEnd?: string
  /** Saldo informado pelo banco e a data dele (OFX: LEDGERBAL; CSV: saldo da última linha). */
  balance?: { amount: number; date: string }
  /** Quando o banco gerou o arquivo: nada depois disso está completo (faturas futuras, F61). */
  generatedOn?: string
  rows: ParsedRow[]
}

export class StatementParseError extends Error {}

// ─── Texto ──────────────────────────────────────────────────────────────────

const BOM = String.fromCharCode(0xfeff)

/**
 * Decodifica o arquivo: UTF-8 (com ou sem BOM) ou Windows-1252. O cabeçalho do OFX do Nubank diz
 * CHARSET:1252, mas o conteúdo vem em UTF-8; por isso UTF-8 válido sempre vence o cabeçalho.
 */
export function decodeStatement(buffer: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer)
    return text.startsWith(BOM) ? text.slice(1) : text
  } catch {
    return new TextDecoder("windows-1252").decode(buffer)
  }
}

/** "1.234,56" ou "-1234.56" → centavos. Vazio ou inválido → null. */
export function parseMoney(raw: string | undefined): number | null {
  if (!raw) return null
  let s = raw.trim().replace(/\s|R\$/g, "")
  if (!s) return null
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".")
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

/** "31/08/2026" → "2026-08-31". */
function brDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}

// ─── OFX (SGML 1.x ou XML 2.x) ──────────────────────────────────────────────

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, "i"))
  return m?.[1]?.trim()
}

/** "20261003000000[-3:BRT]" → "2026-10-03" (a data local do banco, sem converter fuso). */
function ofxDate(raw: string | undefined): string | undefined {
  const m = raw?.match(/^(\d{4})(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined
}

const decodeEntities = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

export function parseOfx(text: string): ParsedStatement {
  if (!/<OFX>/i.test(text)) throw new StatementParseError("Arquivo OFX sem o bloco <OFX>.")
  const isCard = /<CREDITCARDMSGSRSV1>|<CCSTMTRS>/i.test(text)
  const org = (tag(text, "ORG") ?? "").toUpperCase()
  const institution = /NU PAGAMENTOS|NUBANK/.test(org)
    ? "nubank"
    : /BRADESCO/.test(org) || tag(text, "BANKID") === "237"
      ? "bradesco"
      : "other"

  const rows: ParsedRow[] = []
  for (const block of text.split(/<STMTTRN>/i).slice(1)) {
    const body = block.split(/<\/STMTTRN>/i)[0] ?? block
    const date = ofxDate(tag(body, "DTPOSTED"))
    const amount = parseMoney(tag(body, "TRNAMT"))
    const description = decodeEntities(tag(body, "MEMO") || tag(body, "NAME") || "").trim()
    if (!date || amount === null) continue
    rows.push({
      date,
      amount,
      description: description || "(sem descrição)",
      externalId: tag(body, "FITID"),
    })
  }

  const start = ofxDate(tag(text, "DTSTART"))
  const endRaw = ofxDate(tag(text, "DTEND"))
  // Na fatura do Nubank, DTEND é o dia seguinte ao fechamento (exclusivo).
  const end = endRaw && isCard ? addDays(endRaw, -1) : endRaw
  const ledger = text.match(
    /<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>)/i,
  )?.[1]
  const balAmount = ledger ? parseMoney(tag(ledger, "BALAMT")) : null
  const balDate = ledger ? ofxDate(tag(ledger, "DTASOF")) : undefined

  return {
    format: isCard ? "ofx_card" : "ofx_bank",
    institution,
    accountType: isCard ? "credit_card" : "checking",
    periodStart: start,
    periodEnd: end,
    balance: balAmount !== null && balDate ? { amount: balAmount, date: balDate } : undefined,
    generatedOn: ofxDate(tag(text, "DTSERVER")),
    rows,
  }
}

// ─── CSV ────────────────────────────────────────────────────────────────────

/** Divide uma linha CSV respeitando aspas. */
function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = []
  let cur = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"'
        i++
      } else quoted = !quoted
    } else if (ch === sep && !quoted) {
      out.push(cur)
      cur = ""
    } else cur += ch
  }
  out.push(cur)
  return out.map((cell) => cell.trim())
}

const normHeader = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim()

/**
 * Extrato da conta do Bradesco: linha de título, cabeçalho "Data;Histórico;Docto.;Crédito (R$);
 * Débito (R$);Saldo (R$)", lançamentos, rodapé "Os dados acima tem como base dd/mm/aaaa" e uma
 * segunda seção "Lançamentos futuros" (ignorada).
 */
export function parseBradescoCsv(text: string): ParsedStatement {
  const lines = text.split(/\r?\n/)
  const headerIdx = lines.findIndex((l) => /^data;hist/i.test(normHeader(l)))
  if (headerIdx < 0) throw new StatementParseError("Não achei o cabeçalho do extrato do Bradesco.")
  const header = splitCsvLine(lines[headerIdx]!, ";").map(normHeader)
  const col = (name: string) => header.findIndex((h) => h.startsWith(name))
  const [iDate, iHist, iDoc, iCred, iDeb, iBal] = [
    col("data"),
    col("historico"),
    col("docto"),
    col("credito"),
    col("debito"),
    col("saldo"),
  ]

  const rows: ParsedRow[] = []
  for (const line of lines.slice(headerIdx + 1)) {
    const cells = splitCsvLine(line, ";")
    const date = brDate(cells[iDate] ?? "")
    if (!date) {
      // Linha vazia ou rodapé: os lançamentos acabaram (o que vem depois são os futuros).
      if (rows.length) break
      continue
    }
    const credit = parseMoney(cells[iCred])
    const debit = parseMoney(cells[iDeb])
    const amount = (credit ?? 0) - Math.abs(debit ?? 0)
    if (!credit && !debit) continue
    const doc = cells[iDoc]?.trim()
    rows.push({
      date,
      amount,
      description: (cells[iHist] ?? "").replace(/\s+/g, " ").trim() || "(sem descrição)",
      externalId: doc || undefined,
      balanceAfter: iBal >= 0 ? (parseMoney(cells[iBal]) ?? undefined) : undefined,
    })
  }

  const asOf = text.match(/tem como base (\d{2}\/\d{2}\/\d{4})/i)?.[1]
  const asOfDay = asOf ? brDate(asOf) : null
  const last = rows[rows.length - 1]
  const lastWithBalance = [...rows].reverse().find((r) => r.balanceAfter !== undefined)
  return {
    format: "bradesco_csv",
    institution: "bradesco",
    accountType: "checking",
    periodStart: rows[0]?.date,
    // A data-base do arquivo diz até quando ele está completo; sem ela, o último lançamento.
    periodEnd: asOfDay ?? last?.date,
    balance:
      lastWithBalance?.balanceAfter !== undefined
        ? { amount: lastWithBalance.balanceAfter, date: asOfDay ?? lastWithBalance.date }
        : undefined,
    generatedOn: asOfDay ?? undefined,
    rows,
  }
}

/**
 * CSV do Nubank. Conta: "Data,Valor,Identificador,Descrição" (dd/mm/aaaa, valor com sinal).
 * Fatura: "date,title,amount" (aaaa-mm-dd, compra positiva). Formatos a confirmar com arquivos reais.
 */
export function parseNubankCsv(text: string): ParsedStatement {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const header = splitCsvLine(lines[0] ?? "", ",").map(normHeader)
  const rows: ParsedRow[] = []
  if (header[0] === "date" && header.includes("amount")) {
    const [iDate, iTitle, iAmount] = [
      header.indexOf("date"),
      header.indexOf("title"),
      header.indexOf("amount"),
    ]
    for (const line of lines.slice(1)) {
      const c = splitCsvLine(line, ",")
      const amount = parseMoney(c[iAmount])
      if (!/^\d{4}-\d{2}-\d{2}$/.test(c[iDate] ?? "") || amount === null) continue
      rows.push({ date: c[iDate]!, amount: -amount, description: c[iTitle] || "(sem descrição)" })
    }
    const dates = rows.map((r) => r.date).sort()
    return {
      format: "nubank_card_csv",
      institution: "nubank",
      accountType: "credit_card",
      periodStart: dates[0],
      periodEnd: dates[dates.length - 1],
      rows,
    }
  }
  const [iDate, iValue, iId, iDesc] = [
    header.indexOf("data"),
    header.indexOf("valor"),
    header.indexOf("identificador"),
    header.findIndex((h) => h.startsWith("descri")),
  ]
  if (iDate < 0 || iValue < 0)
    throw new StatementParseError("CSV do Nubank com colunas desconhecidas.")
  for (const line of lines.slice(1)) {
    const c = splitCsvLine(line, ",")
    const date = brDate(c[iDate] ?? "")
    const amount = parseMoney(c[iValue])
    if (!date || amount === null) continue
    rows.push({
      date,
      amount,
      description: c[iDesc] || "(sem descrição)",
      externalId: c[iId] || undefined,
    })
  }
  const dates = rows.map((r) => r.date).sort()
  return {
    format: "nubank_csv",
    institution: "nubank",
    accountType: "checking",
    periodStart: dates[0],
    periodEnd: dates[dates.length - 1],
    rows,
  }
}

/** Detecta o formato pelo conteúdo (o nome do arquivo não é confiável). */
export function parseStatement(buffer: Uint8Array): ParsedStatement {
  const text = decodeStatement(buffer)
  if (/<OFX>/i.test(text) || /^OFXHEADER/m.test(text)) return parseOfx(text)
  const head = text.split(/\r?\n/).slice(0, 15).map(normHeader)
  if (head.some((l) => l.startsWith("data;hist"))) return parseBradescoCsv(text)
  const first = head.find((l) => l) ?? ""
  if (first.startsWith("data,valor") || first.startsWith("date,")) return parseNubankCsv(text)
  if (/extrato de: ag/i.test(text)) return parseBradescoCsv(text)
  throw new StatementParseError("Formato de extrato não reconhecido. Use OFX ou CSV do banco.")
}
