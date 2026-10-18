import { buildApp } from "./app.js"
import { env } from "./config/env.js"

const SHUTDOWN_TIMEOUT_MS = 10_000

const app = await buildApp()

// Railway envia SIGTERM a cada deploy: espera as requisições em andamento e fecha o pool.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "Encerrando servidor")
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref()
    await app.close()
    process.exit(0)
  })
}

try {
  await app.listen({ port: env.PORT, host: env.HOST })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
