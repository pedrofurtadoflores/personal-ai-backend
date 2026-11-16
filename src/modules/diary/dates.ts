/** O dia do diário vira às 4h (America/Sao_Paulo): uma entrada à 1h ainda é do dia anterior. */
export const DIARY_ROLLOVER_HOURS = 4
const TIMEZONE = "America/Sao_Paulo"

/** Data (YYYY-MM-DD) do dia do diário em `now`. */
export function diaryToday(now = new Date()) {
  return new Date(now.getTime() - DIARY_ROLLOVER_HOURS * 3_600_000).toLocaleDateString("en-CA", {
    timeZone: TIMEZONE,
  })
}

/** YYYY-MM-DD que existe no calendário (recusa 2026-02-31). */
export function isRealDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** "sexta-feira, 14 de novembro de 2026" */
export function longDate(value: string) {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString("pt-BR", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
}

/** Primeiro e último dia do mês (YYYY-MM) como YYYY-MM-DD. */
export function monthRange(month: string) {
  const [year, number] = month.split("-").map(Number) as [number, number]
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` }
}
