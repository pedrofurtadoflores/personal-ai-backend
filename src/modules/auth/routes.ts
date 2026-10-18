import bcrypt from "bcryptjs"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { env } from "../../config/env.js"
import { errorResponse } from "../../lib/http.js"
import { registerFailure, registerSuccess, retryAfterSeconds } from "./login-throttle.js"
import { bumpSessionVersion, passwordFingerprint, sessionVersion } from "./session.js"

// bcrypt ignora tudo depois de 72 bytes: senhas maiores dariam uma falsa sensação de segurança.
const BCRYPT_MAX_BYTES = 72

const loginBody = z.object({
  password: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, "utf8") <= BCRYPT_MAX_BYTES, {
      message: `A senha pode ter no máximo ${BCRYPT_MAX_BYTES} bytes`,
    }),
})

const loginResponse = z.object({ token: z.string(), expiresAt: z.iso.datetime() })

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/auth/login",
    {
      config: {
        public: true,
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
      schema: {
        tags: ["auth"],
        summary: "Entrar com a senha do app",
        security: [],
        body: loginBody,
        response: { 200: loginResponse, 401: errorResponse, 429: errorResponse },
      },
    },
    async (request, reply) => {
      const wait = retryAfterSeconds(request.ip)
      if (wait > 0) {
        return reply
          .code(429)
          .header("retry-after", wait)
          .send({ error: "rate_limited", message: `Tente novamente em ${wait}s` })
      }

      const valid = await bcrypt.compare(request.body.password, env.APP_PASSWORD_HASH)
      if (!valid) {
        registerFailure(request.ip)
        request.log.warn({ ip: request.ip }, "Tentativa de login com senha incorreta")
        return reply.code(401).send({ error: "invalid_password" })
      }

      registerSuccess(request.ip)
      const token = app.jwt.sign({ sub: "owner", sv: sessionVersion(), pf: passwordFingerprint })
      const { exp } = app.jwt.decode<{ exp: number }>(token)!

      return { token, expiresAt: new Date(exp * 1000).toISOString() }
    },
  )

  app.get(
    "/auth/me",
    {
      schema: {
        tags: ["auth"],
        summary: "Verificar se o token ainda é válido",
        response: { 200: z.object({ authenticated: z.literal(true) }) },
      },
    },
    async () => ({ authenticated: true as const }),
  )

  app.post(
    "/auth/logout-all",
    {
      schema: {
        tags: ["auth"],
        summary: "Sair de todos os dispositivos (invalida todos os tokens)",
        response: { 204: z.null() },
      },
    },
    async (_request, reply) => {
      await bumpSessionVersion()
      return reply.code(204).send(null)
    },
  )
}
