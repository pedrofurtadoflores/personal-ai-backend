/**
 * Proteção do login contra força bruta (D44).
 *
 * - Por chave (IPv4 ou prefixo IPv6 /64): depois de FREE_ATTEMPTS falhas, cada nova falha
 *   dobra o bloqueio (1 min, 2 min, 4 min...) até 24 h. Fica no banco para sobreviver a deploys.
 * - Global: no máximo LOGIN_GLOBAL_MAX_PER_MINUTE tentativas por minuto somando todos os IPs,
 *   para um ataque distribuído não saturar a CPU com bcrypt. Fica em memória (janela de 1 min).
 */
import { eq, lt, sql } from "drizzle-orm"
import { env } from "../../config/env.js"
import { db } from "../../db/client.js"
import { loginThrottle } from "../../db/schema.js"

const FREE_ATTEMPTS = 5
const BASE_LOCK_MS = 60_000
const MAX_LOCK_MS = 24 * 60 * 60_000
const GLOBAL_WINDOW_MS = 60_000

let globalWindowStart = 0
let globalAttempts = 0

/** Conta a tentativa na janela global. Devolve segundos de espera, ou 0 se pode tentar. */
export function takeGlobalAttempt(now = Date.now()): number {
  if (now - globalWindowStart >= GLOBAL_WINDOW_MS) {
    globalWindowStart = now
    globalAttempts = 0
  }
  if (globalAttempts >= env.LOGIN_GLOBAL_MAX_PER_MINUTE) {
    return Math.ceil((globalWindowStart + GLOBAL_WINDOW_MS - now) / 1000)
  }
  globalAttempts += 1
  return 0
}

/** Segundos restantes de bloqueio para a chave, ou 0 se pode tentar. */
export async function retryAfterSeconds(key: string, now = Date.now()): Promise<number> {
  const [row] = await db
    .select({ lockedUntil: loginThrottle.lockedUntil })
    .from(loginThrottle)
    .where(eq(loginThrottle.key, key))
  const lockedUntil = row?.lockedUntil?.getTime() ?? 0
  return lockedUntil > now ? Math.ceil((lockedUntil - now) / 1000) : 0
}

export async function registerFailure(key: string, now = Date.now()) {
  const [row] = await db
    .insert(loginThrottle)
    .values({ key, failures: 1, lastFailureAt: new Date(now) })
    .onConflictDoUpdate({
      target: loginThrottle.key,
      set: { failures: sql`${loginThrottle.failures} + 1`, lastFailureAt: new Date(now) },
    })
    .returning({ failures: loginThrottle.failures })

  const failures = row?.failures ?? 1
  if (failures >= FREE_ATTEMPTS) {
    const lockMs = Math.min(BASE_LOCK_MS * 2 ** (failures - FREE_ATTEMPTS), MAX_LOCK_MS)
    await db
      .update(loginThrottle)
      .set({ lockedUntil: new Date(now + lockMs) })
      .where(eq(loginThrottle.key, key))
  }

  // Esquece chaves sem falhas há mais de 24 h.
  await db.delete(loginThrottle).where(lt(loginThrottle.lastFailureAt, new Date(now - MAX_LOCK_MS)))
}

export async function registerSuccess(key: string) {
  await db.delete(loginThrottle).where(eq(loginThrottle.key, key))
}

/** Só para testes. */
export async function resetThrottle() {
  globalWindowStart = 0
  globalAttempts = 0
  await db.delete(loginThrottle)
}
