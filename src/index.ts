import { buildApp } from "./app.js"
import { env } from "./config/env.js"

const SHUTDOWN_TIMEOUT_MS = 10_000

const app = await buildApp()

let shuttingDown = false

// Railway envia SIGTERM a cada deploy: espera as requisições em andamento e fecha o pool.
// Um segundo sinal (ex.: Ctrl+C de novo) força a saída na hora.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1)
    shuttingDown = true
    app.log.info({ signal }, "Encerrando servidor")
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref()
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error(error, "Erro ao encerrar")
        process.exit(1)
      },
    )
  })
}

try {
  await app.listen({ port: env.PORT, host: env.HOST })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
