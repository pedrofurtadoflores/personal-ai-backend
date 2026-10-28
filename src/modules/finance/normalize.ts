/**
 * Interpretação das descrições do banco: chave do estabelecimento, parcelas, IOF, estornos e
 * pagamento de fatura. Funções puras, testadas sem banco.
 */
import { createHash } from "node:crypto"
import type { ParsedRow } from "./parse.js"

/** Sem acento, maiúsculas, espaços simples. É o texto que as regras leem (F13). */
export function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim()
}

const INSTALLMENT = /\s*-\s*PARCELA\s+(\d{1,3})\s*\/\s*(\d{1,3})\s*$/i

/** "Leonor Modas - Parcela 3/10" → { base: "Leonor Modas", number: 3, total: 10 }. */
export function parseInstallment(description: string) {
  const m = description.match(INSTALLMENT)
  if (!m) return null
  const number = Number(m[1])
  const total = Number(m[2])
  if (!number || !total || number > total) return null
  return { base: description.replace(INSTALLMENT, "").trim(), number, total }
}

/**
 * Chave do estabelecimento: a descrição sem parcela, sem números longos e sem prefixos de
 * gateway ("PG *", "EBN*"). Agrupa "IFD*IFOOD.COM 123" e "IFD*IFOOD.COM 456".
 */
export function merchantKey(description: string): string {
  const base = parseInstallment(description)?.base ?? description
  return normalizeText(base)
    .replace(/^(IOF DE|ESTORNO DE|CREDITO DE)\s+/, "")
    .replace(/["“”]/g, "")
    .replace(/\d{3,}/g, "")
    .replace(/[*#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
}

/** Para onde aponta um lançamento de IOF, estorno ou crédito: `IOF de "Vercel Inc."` → "Vercel Inc.". */
export function referencedMerchant(description: string): string | null {
  const m = description.match(/^(?:IOF de|Estorno de|Cr[eé]dito de)\s+"(.+?)"/i)
  return m ? m[1]! : null
}

export type RowKind = "purchase" | "iof" | "refund" | "card_payment" | "other"

/** Classificação estrutural (não é categoria): o que o lançamento é, pelo texto e pelo sinal. */
export function rowKind(row: Pick<ParsedRow, "description" | "amount">, isCard: boolean): RowKind {
  const d = normalizeText(row.description)
  if (isCard && row.amount > 0 && /^PAGAMENTO (RECEBIDO|EFETUADO)/.test(d)) return "card_payment"
  if (/^IOF DE /.test(d)) return "iof"
  if (row.amount > 0 && /^(ESTORNO DE|CREDITO DE|ESTORNO )/.test(d)) return "refund"
  if (isCard && row.amount < 0) return "purchase"
  return "other"
}

/** Pagamento de fatura visto da conta corrente (transferência interna, F17). */
export function looksLikeCardBillPayment(description: string): boolean {
  return /PAGAMENTO DE FATURA|PAGTO.*FATURA|FATURA (NUBANK|CARTAO)|NU PAGAMENTOS/.test(
    normalizeText(description),
  )
}

/**
 * Identidade de cada linha no banco (F08). O FITID do Nubank se repete (o IOF usa o da compra),
 * então a identidade é FITID + data + valor + descrição, e um contador desempata linhas idênticas
 * no mesmo arquivo (duas compras iguais no mesmo dia são duas transações).
 */
export function fingerprints(rows: ParsedRow[]): string[] {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const base = [row.externalId ?? "", row.date, row.amount, normalizeText(row.description)].join(
      "|",
    )
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return createHash("sha256").update(`${base}|${n}`).digest("hex").slice(0, 32)
  })
}

/**
 * Grupo de uma compra parcelada: mesma loja, mesmo total de parcelas e mesmo valor em reais
 * inteiros (o banco varia a parcela em centavos: R$ 53,34 e R$ 53,32 são a mesma compra).
 */
export function installmentGroup(accountId: string, base: string, total: number, amount: number) {
  return createHash("sha256")
    .update([accountId, merchantKey(base), total, Math.round(Math.abs(amount) / 100)].join("|"))
    .digest("hex")
    .slice(0, 24)
}

/** Descrição mais legível: "IFD*IFOOD.COM AGENCIA" → "Ifd*ifood.com Agencia" fica como veio; só limpa espaços. */
export function displayDescription(description: string): string {
  const d = description.replace(/\s+/g, " ").trim()
  // Textos todos em maiúsculas (Bradesco) ficam com só a primeira letra maiúscula.
  if (d === d.toUpperCase() && /[A-Z]/.test(d)) return d.charAt(0) + d.slice(1).toLowerCase()
  return d
}
