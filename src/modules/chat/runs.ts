import type { FastifyReply } from "fastify"
import { HttpError } from "../../lib/http.js"
import { openSse } from "../../lib/sse.js"

/**
 * Respostas em andamento (D68). A geração não depende da conexão: fechar a aba, bloquear o
 * celular ou trocar de rede não interrompe nada. Os eventos ficam guardados até o fim, e quem
 * se reconecta (`GET /conversations/:id/stream`) recebe tudo desde o começo. Parar é um pedido
 * explícito (`POST /conversations/:id/stop`).
 *
 * Também é a trava de "uma resposta por vez" (D66). Fica em memória porque o backend roda num
 * processo só; se ele reiniciar no meio, a mensagem é marcada como erro na subida.
 */
type RunEvent = { event: string; data: unknown }
type Listener = (event: RunEvent | null) => void

export type Emit = (event: string, data: unknown) => void

export class Run {
  readonly events: RunEvent[] = []
  readonly controller = new AbortController()
  private listeners = new Set<Listener>()
  private finished = false
  private resolveDone!: () => void
  readonly done = new Promise<void>((resolve) => (this.resolveDone = resolve))

  constructor(readonly conversationId: string) {}

  get isFinished() {
    return this.finished
  }

  emit: Emit = (event, data) => {
    if (this.finished) return
    const item = { event, data }
    this.events.push(item)
    for (const listener of this.listeners) listener(item)
  }

  /** Recebe os eventos já emitidos e os próximos; `null` marca o fim. */
  subscribe(listener: Listener) {
    for (const item of this.events) listener(item)
    if (this.finished) {
      listener(null)
      return () => {}
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Roda a geração em segundo plano; a trava é liberada quando ela termina. */
  start(work: (emit: Emit, signal: AbortSignal) => Promise<void>) {
    void work(this.emit, this.controller.signal)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Erro desconhecido"
        this.emit("error", { error: "generation_failed", message })
      })
      .finally(() => this.finish())
  }

  /** Desiste antes de começar (ex.: validação falhou depois de pegar a trava). */
  discard() {
    this.finish()
  }

  private finish() {
    if (this.finished) return
    this.finished = true
    if (runs.get(this.conversationId) === this) runs.delete(this.conversationId)
    for (const listener of this.listeners) listener(null)
    this.listeners.clear()
    this.resolveDone()
  }
}

const runs = new Map<string, Run>()

/** Pega a trava da conversa. Síncrono de propósito: dois pedidos simultâneos não passam juntos. */
export function createRun(conversationId: string) {
  if (runs.has(conversationId)) {
    throw new HttpError(409, "reply_in_progress", "Espere a resposta atual terminar.")
  }
  const run = new Run(conversationId)
  runs.set(conversationId, run)
  return run
}

export const activeRun = (conversationId: string) => runs.get(conversationId)

export function stopRun(conversationId: string) {
  const run = runs.get(conversationId)
  if (!run) return false
  run.controller.abort()
  return true
}

/** Para todas (desligamento do servidor): cada uma salva o parcial como `stopped`. */
export async function stopAllRuns() {
  const pending = [...runs.values()]
  for (const run of pending) run.controller.abort()
  await Promise.all(pending.map((run) => run.done))
}

/**
 * Transmite a resposta por SSE até ela terminar. Se o cliente desconectar, só deixa de
 * transmitir: a geração continua.
 */
export async function pipeRun(reply: FastifyReply, run: Run) {
  const sse = openSse(reply)
  await new Promise<void>((resolve) => {
    let unsubscribe = () => {}
    const close = () => {
      unsubscribe()
      resolve()
    }
    reply.raw.on("close", close)
    unsubscribe = run.subscribe((item) => {
      if (item) return sse.send(item.event, item.data)
      sse.end()
      close()
    })
  })
}
