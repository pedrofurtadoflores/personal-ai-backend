/**
 * Fila de jobs em background com pg-boss (D16): usa o próprio Postgres, sem Redis.
 * Em testes a fila fica desligada: os jobs são só registrados em `enqueuedJobs`
 * e os handlers são chamados direto pelos testes.
 */
import { PgBoss } from "pg-boss"
import { env } from "../config/env.js"

export type JobName =
  | "conversation.title"
  | "sinapses.consolidate"
  | "messages.embed"
  | "files.process"
  | "models.sync"
  | "sinapses.reindex-all"
  | "backups.run"

type Handler = (data: Record<string, unknown>) => Promise<void>

const STATELY = new Set<JobName>([
  "conversation.title",
  "sinapses.consolidate",
  "models.sync",
  "sinapses.reindex-all",
  "backups.run",
])

const handlers = new Map<JobName, Handler>()
let boss: PgBoss | undefined

/** Só em testes: jobs que teriam sido enfileirados. */
export const enqueuedJobs: { name: JobName; data: Record<string, unknown> }[] = []

export function registerJob<T extends Record<string, unknown>>(
  name: JobName,
  handler: (data: T) => Promise<void>,
) {
  handlers.set(name, handler as Handler)
}

export async function runJobNow(name: JobName, data: Record<string, unknown> = {}) {
  const handler = handlers.get(name)
  if (!handler) throw new Error(`Job sem handler: ${name}`)
  await handler(data)
}

/**
 * Enfileira um job.
 * - `delaySeconds`: só roda depois desse tempo (o job pode se reagendar se ainda não for a hora).
 * - `key` + `singleton`/`delaySeconds`: no máximo um job pendente por chave.
 */
export async function enqueue(
  name: JobName,
  data: Record<string, unknown> = {},
  options: { delaySeconds?: number; key?: string; singleton?: boolean } = {},
) {
  if (!boss) {
    enqueuedJobs.push({ name, data })
    return
  }
  const unique = options.singleton || options.delaySeconds
  await boss.send(name, data, {
    ...(unique ? { singletonKey: options.key ?? name } : {}),
    ...(options.delaySeconds ? { startAfter: options.delaySeconds } : {}),
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
  })
}

export async function startJobs(log: {
  info: (msg: string) => void
  error: (...args: unknown[]) => void
}) {
  if (env.NODE_ENV === "test" || boss) return
  boss = new PgBoss({ connectionString: env.DATABASE_URL, schema: "pgboss" })
  boss.on("error", (error) => log.error(error, "Erro no pg-boss"))
  await boss.start()

  for (const [name, handler] of handlers) {
    // stately: no máximo 1 pendente e 1 rodando por chave (dedup de consolidação, títulos, sync).
    const policy = STATELY.has(name) ? "stately" : "standard"
    const existing = await boss.getQueue(name)
    if (existing && existing.policy !== policy) await boss.deleteQueue(name)
    if (!existing || existing.policy !== policy) await boss.createQueue(name, { policy })
    await boss.work<Record<string, unknown>>(name, async (jobs) => {
      for (const job of jobs) await handler(job.data ?? {})
    })
  }

  // Tarefas periódicas.
  await boss.schedule("models.sync", "0 6 * * *", {}, { tz: "America/Sao_Paulo" })
  await boss.schedule("backups.run", "0 3 * * 0", {}, { tz: "America/Sao_Paulo" })
  log.info(`Jobs iniciados: ${[...handlers.keys()].join(", ")}`)
}

export async function stopJobs() {
  await boss?.stop({ graceful: true, timeout: 8_000 })
  boss = undefined
}
