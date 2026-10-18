import cors from "@fastify/cors"
import rateLimit from "@fastify/rate-limit"
import swagger from "@fastify/swagger"
import swaggerUi from "@fastify/swagger-ui"
import Fastify, { type FastifyError } from "fastify"
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod"
import { env } from "./config/env.js"
import { pool } from "./db/client.js"
import { errorCode } from "./lib/http.js"
import { authRoutes } from "./modules/auth/routes.js"
import { healthRoutes } from "./modules/health/routes.js"
import { authPlugin } from "./plugins/auth.js"

const isProduction = env.NODE_ENV === "production"

export async function buildApp() {
  const app = Fastify({
    logger: { level: env.NODE_ENV === "test" ? "silent" : "info" },
    trustProxy: env.TRUST_PROXY,
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: "validation_error",
        message: "Dados inválidos",
        details: error.validation,
      })
    }

    const status = error.statusCode ?? 500
    if (status >= 500) {
      request.log.error(error)
      // Não vaza detalhes internos (SQL, stack) para o cliente.
      return reply.code(500).send({ error: "internal_error" })
    }

    return reply.code(status).send({ error: errorCode(status, error.code), message: error.message })
  })

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "not_found" }))

  app.addHook("onClose", async () => {
    await pool.end()
  })

  await app.register(cors, {
    origin: env.FRONTEND_URL,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["authorization", "content-type"],
    exposedHeaders: ["retry-after"],
    maxAge: 600,
  })

  // Sem limite global: cada rota define o seu (login agora; chat e OpenAI nas próximas fases).
  await app.register(rateLimit, { global: false })

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

  // Contrato da API para o front gerar os tipos (npm run api:types). Público só fora de produção.
  app.get(
    "/openapi.json",
    { config: { public: !isProduction }, schema: { hide: true } },
    async () => app.swagger(),
  )
  if (!isProduction) {
    await app.register(swaggerUi, {
      routePrefix: "/docs",
      uiConfig: { persistAuthorization: true },
    })
  }

  await app.register(authPlugin)

  await app.register(healthRoutes)
  await app.register(authRoutes)

  return app
}
