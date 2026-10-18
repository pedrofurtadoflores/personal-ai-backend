import type { FastifyReply } from "fastify"

/**
 * Server-Sent Events sobre a resposta crua. O front lê com fetch + ReadableStream (D38),
 * porque EventSource não envia o header Authorization.
 */
export function openSse(reply: FastifyReply) {
  reply.hijack()
  const raw = reply.raw
  // Com hijack os hooks do Fastify não rodam: copia os headers já definidos (CORS, segurança).
  raw.writeHead(200, {
    ...(reply.getHeaders() as Record<string, string>),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  })

  // Mantém a conexão viva atrás de proxies que fecham conexões ociosas.
  const keepAlive = setInterval(() => raw.write(": ping\n\n"), 15_000)
  let closed = false
  raw.on("close", () => {
    closed = true
    clearInterval(keepAlive)
  })

  return {
    send(event: string, data: unknown) {
      if (closed) return
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    end() {
      clearInterval(keepAlive)
      if (!closed) raw.end()
      closed = true
    },
    get closed() {
      return closed
    },
  }
}

export type SseChannel = ReturnType<typeof openSse>
