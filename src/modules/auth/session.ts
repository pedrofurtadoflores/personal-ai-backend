import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import { env } from "../../config/env.js"
import { db } from "../../db/client.js"
import { settings } from "../../db/schema.js"

const SESSION_VERSION_KEY = "auth.session_version"

/**
 * Impressão digital da senha atual: trocar APP_PASSWORD_HASH invalida todos os tokens.
 */
export const passwordFingerprint = createHash("sha256")
  .update(env.APP_PASSWORD_HASH)
  .digest("base64url")
  .slice(0, 16)

export type SessionPayload = { sub: "owner"; sv: number; pf: string }

// Cache em memória: o backend roda em uma única instância (single-user).
let currentVersion = 1

export async function loadSessionVersion() {
  const [row] = await db.select().from(settings).where(eq(settings.key, SESSION_VERSION_KEY))
  currentVersion = typeof row?.value === "number" ? row.value : 1
}

export function sessionVersion() {
  return currentVersion
}

/** "Sair de todos os dispositivos": invalida todos os tokens emitidos até agora. */
export async function bumpSessionVersion() {
  const next = currentVersion + 1
  await db
    .insert(settings)
    .values({ key: SESSION_VERSION_KEY, value: next })
    .onConflictDoUpdate({ target: settings.key, set: { value: next } })
  currentVersion = next
}

export function isSessionValid(payload: Partial<SessionPayload>) {
  return payload.sv === currentVersion && payload.pf === passwordFingerprint
}
