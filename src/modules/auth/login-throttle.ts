/**
 * Bloqueio progressivo por IP contra força bruta lenta.
 * Depois de FREE_ATTEMPTS falhas, cada nova falha dobra o bloqueio (1 min, 2 min, 4 min...) até 24 h.
 * Fica em memória: o backend roda em uma única instância.
 */

const FREE_ATTEMPTS = 5
const BASE_LOCK_MS = 60_000
const MAX_LOCK_MS = 24 * 60 * 60_000
const MAX_ENTRIES = 10_000

type Entry = { failures: number; lockedUntil: number; lastFailure: number }

const entries = new Map<string, Entry>()

/** Segundos restantes de bloqueio, ou 0 se pode tentar. */
export function retryAfterSeconds(ip: string, now = Date.now()): number {
  const entry = entries.get(ip)
  if (!entry || entry.lockedUntil <= now) return 0
  return Math.ceil((entry.lockedUntil - now) / 1000)
}

export function registerFailure(ip: string, now = Date.now()) {
  prune(now)
  const entry = entries.get(ip) ?? { failures: 0, lockedUntil: 0, lastFailure: 0 }
  entry.failures += 1
  entry.lastFailure = now
  if (entry.failures >= FREE_ATTEMPTS) {
    const exponent = entry.failures - FREE_ATTEMPTS
    entry.lockedUntil = now + Math.min(BASE_LOCK_MS * 2 ** exponent, MAX_LOCK_MS)
  }
  entries.set(ip, entry)
}

export function registerSuccess(ip: string) {
  entries.delete(ip)
}

/** Esquece IPs sem falhas há mais de 24 h e limita o tamanho do mapa. */
function prune(now: number) {
  if (entries.size < MAX_ENTRIES) return
  for (const [ip, entry] of entries) {
    if (now - entry.lastFailure > MAX_LOCK_MS) entries.delete(ip)
  }
  if (entries.size >= MAX_ENTRIES) entries.clear()
}

export function resetThrottle() {
  entries.clear()
}
