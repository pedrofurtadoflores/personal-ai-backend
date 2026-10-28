/** Regras do usuário (F13): rodam antes da IA, sobre a descrição original normalizada. */
import type { finRules } from "../../db/schema.js"
import { merchantKey, normalizeText } from "./normalize.js"

export type Rule = typeof finRules.$inferSelect

export function ruleMatches(
  rule: Pick<
    Rule,
    "matchType" | "pattern" | "accountId" | "minAmount" | "maxAmount" | "sign" | "enabled"
  >,
  tx: { description: string; accountId: string; amount: number },
): boolean {
  if (!rule.enabled) return false
  if (rule.accountId && rule.accountId !== tx.accountId) return false
  if (rule.sign && Math.sign(tx.amount) !== Math.sign(rule.sign)) return false
  const abs = Math.abs(tx.amount)
  if (rule.minAmount !== null && rule.minAmount !== undefined && abs < rule.minAmount) return false
  if (rule.maxAmount !== null && rule.maxAmount !== undefined && abs > rule.maxAmount) return false
  // Compara com o texto normalizado e com a chave do estabelecimento (sem números e "*"),
  // que é a forma usada pelas regras sugeridas.
  const texts = [normalizeText(tx.description), merchantKey(tx.description)]
  const pattern = rule.matchType === "regex" ? rule.pattern : normalizeText(rule.pattern)
  if (rule.matchType === "equals") return texts.includes(pattern)
  if (rule.matchType === "contains") return texts.some((t) => t.includes(pattern))
  try {
    const re = new RegExp(pattern, "i")
    return texts.some((t) => re.test(t))
  } catch {
    return false
  }
}

/** Primeira regra que casa, pela prioridade (maior primeiro) e depois pela mais antiga. */
export function firstMatchingRule<
  R extends Parameters<typeof ruleMatches>[0] & { priority: number; createdAt: Date },
>(rules: R[], tx: { description: string; accountId: string; amount: number }): R | undefined {
  return [...rules]
    .sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime())
    .find((rule) => ruleMatches(rule, tx))
}

/** Valida um padrão de regra antes de salvar (regex inválida vira erro 400). */
export function isValidPattern(matchType: Rule["matchType"], pattern: string): boolean {
  if (!pattern.trim()) return false
  if (matchType !== "regex") return true
  try {
    new RegExp(pattern, "i")
    return true
  } catch {
    return false
  }
}
