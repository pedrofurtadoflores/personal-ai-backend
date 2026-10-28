/** Datas do Financeiro: sempre strings "YYYY-MM-DD" (dia local) e meses "YYYY-MM". */

const pad = (n: number) => String(n).padStart(2, "0")

/** Hoje no fuso de São Paulo (o app é de um usuário só, no Brasil). */
export function today(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now)
}

export const monthOf = (day: string) => day.slice(0, 7)
export const firstDay = (month: string) => `${month}-01`

export function lastDayNumber(month: string): number {
  return new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate()
}

export const lastDay = (month: string) => `${month}-${pad(lastDayNumber(month))}`

export function addMonths(month: string, n: number): string {
  const d = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 + n, 1))
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000)
}

/** Dia do mês, limitado ao último dia (dia 31 em fevereiro vira 28/29). */
export function dayInMonth(month: string, dayOfMonth: number): string {
  return `${month}-${pad(Math.min(Math.max(dayOfMonth, 1), lastDayNumber(month)))}`
}

export const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
export const isMonth = (value: string) => /^\d{4}-\d{2}$/.test(value)
