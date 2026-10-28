import cors from "@fastify/cors"
import multipart from "@fastify/multipart"
import rateLimit from "@fastify/rate-limit"
import swagger from "@fastify/swagger"
import Fastify, { type FastifyError, type FastifyRequest } from "fastify"
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod"
import { env } from "./config/env.js"
import { db, pool } from "./db/client.js"
import { modelCatalog } from "./db/schema.js"
import { clientKey } from "./lib/client-ip.js"
import { errorCode, errorMessages, HttpError } from "./lib/http.js"
import { enqueue, startJobs, stopJobs } from "./lib/jobs.js"
import { audioRoutes } from "./modules/audio/routes.js"
import { authRoutes } from "./modules/auth/routes.js"
import { backupRoutes } from "./modules/backups/routes.js"
import "./modules/backups/service.js"
import "./modules/chat/jobs.js"
import { chatRoutes } from "./modules/chat/routes.js"
import { stopAllRuns } from "./modules/chat/runs.js"
import { conversationRoutes } from "./modules/conversations/routes.js"
import { fileRoutes } from "./modules/files/routes.js"
import { financeRoutes } from "./modules/finance/routes.js"
import { healthRoutes } from "./modules/health/routes.js"
import { modelRoutes } from "./modules/models/routes.js"
import "./modules/models/service.js"
import { searchRoutes } from "./modules/search/routes.js"
import { settingsRoutes } from "./modules/settings/routes.js"
import "./modules/sinapses/consolidation.js"
import { sinapseRoutes } from "./modules/sinapses/routes.js"
import { usageRoutes } from "./modules/usage/routes.js"
import { authPlugin } from "./plugins/auth.js"

const isProduction = env.NODE_ENV === "production"
const DOCS_PREFIX = "/docs"

function isAllowedOrigin(origin: string) {
  return env.FRONTEND_URL.includes(origin) || (env.FRONTEND_URL_PATTERN?.test(origin) ?? false)
}

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "test" ? "silent" : "info",
      serializers: {
        // Só o caminho: query strings nunca vão para o log (regra: token nunca na URL).
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: request.url.split("?")[0],
          ip: request.ip,
        }),
      },
    },
    trustProxy: env.TRUST_PROXY,
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: "validation_error",
        message: errorMessages.validation_error,
        details: error.validation,
      })
    }

    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message })
    }

    const status = error.statusCode ?? 500
    if (status >= 500) {
      request.log.error(error)
      // Não vaza detalhes internos (SQL, stack) para o cliente.
      return reply
        .code(500)
        .send({ error: "internal_error", message: errorMessages.internal_error })
    }

    const code = errorCode(status, error.code)
    return reply.code(status).send({ error: code, message: errorMessages[code] })
  })

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: "not_found", message: errorMessages.not_found }),
  )

  // Headers de segurança para uma API JSON (o front tem os seus, no next.config.ts).
  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff")
    reply.header("referrer-policy", "no-referrer")
    reply.header("x-robots-tag", "noindex, nofollow")
    if (!reply.request.url.startsWith(DOCS_PREFIX)) reply.header("x-frame-options", "DENY")
  })

  // Jobs em background (pg-boss) sobem junto com o servidor e param antes do pool.
  app.addHook("onReady", async () => {
    await startJobs(app.log)
    if (env.NODE_ENV === "test" || !env.OPENAI_API_KEY) return
    const [anyModel] = await db.select({ id: modelCatalog.id }).from(modelCatalog).limit(1)
    if (!anyModel) await enqueue("models.sync")
  })

  app.addHook("onClose", async () => {
    // Para as respostas em andamento (salvam o parcial) antes de fechar o banco.
    await stopAllRuns()
    await stopJobs()
    await pool.end()
  })

  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || isAllowedOrigin(origin)),
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["authorization", "content-type"],
    exposedHeaders: ["retry-after"],
    maxAge: 600,
  })

  // Áudio do ditado (multipart). Uploads de arquivo vão direto ao R2, não passam aqui.
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } })

  // Sem limite global: cada rota que custa caro (login, OpenAI) define o seu.
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) => clientKey(request.ip),
  })

  await app.register(swagger, {
    openapi: {
      info: { title: "Personal AI API", version: "0.1.0" },
      components: {
        securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  })

  // Contrato da API (também versionado em openapi.json). Público só fora de produção.
  app.get(
    "/openapi.json",
    { config: { public: !isProduction }, schema: { hide: true } },
    async () => app.swagger(),
  )

  if (!isProduction) {
    // As rotas do Swagger UI são públicas em desenvolvimento (o navegador não manda o token).
    app.addHook("onRoute", (route) => {
      if (route.url.startsWith(DOCS_PREFIX)) route.config = { ...route.config, public: true }
    })
    // Import dinâmico: o pacote é dependência de desenvolvimento e não existe na imagem de produção.
    const { default: swaggerUi } = await import("@fastify/swagger-ui")
    await app.register(swaggerUi, {
      routePrefix: DOCS_PREFIX,
      uiConfig: { persistAuthorization: true },
    })
  }

  await app.register(authPlugin)

  await app.register(healthRoutes)
  await app.register(authRoutes)
  await app.register(settingsRoutes)
  await app.register(modelRoutes)
  await app.register(usageRoutes)
  await app.register(conversationRoutes)
  await app.register(chatRoutes)
  await app.register(fileRoutes)
  await app.register(sinapseRoutes)
  await app.register(searchRoutes)
  await app.register(audioRoutes)
  await app.register(backupRoutes)
  await app.register(financeRoutes)

  return app
}
