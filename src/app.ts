import cors from "@fastify/cors"
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
import { pool } from "./db/client.js"
import { clientKey } from "./lib/client-ip.js"
import { errorCode, errorMessages } from "./lib/http.js"
import { authRoutes } from "./modules/auth/routes.js"
import { healthRoutes } from "./modules/health/routes.js"
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

  app.addHook("onClose", async () => {
    await pool.end()
  })

  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || isAllowedOrigin(origin)),
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["authorization", "content-type"],
    exposedHeaders: ["retry-after"],
    maxAge: 600,
  })

  // Sem limite global: cada rota define o seu (login agora; chat e OpenAI nas próximas fases).
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

  return app
}
