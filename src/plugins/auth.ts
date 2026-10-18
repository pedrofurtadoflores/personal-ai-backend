import fastifyJwt from "@fastify/jwt"
import type { FastifyInstance } from "fastify"
import fp from "fastify-plugin"
import { env } from "../config/env.js"
import { isSessionValid, loadSessionVersion, type SessionPayload } from "../modules/auth/session.js"

declare module "fastify" {
  interface FastifyContextConfig {
    /** Rotas marcadas como públicas não exigem token. */
    public?: boolean
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: SessionPayload
    user: SessionPayload
  }
}

/**
 * Single-user: todo token válido é o dono do app (D08).
 * O token só vale se a versão de sessão e a impressão digital da senha baterem.
 * Envolvido em fastify-plugin para o hook e o `app.jwt` valerem para todas as rotas.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
  })

  app.addHook("onReady", loadSessionVersion)

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS" || request.is404 || request.routeOptions.config.public) return

    try {
      const payload = await request.jwtVerify<SessionPayload>()
      if (isSessionValid(payload)) return
    } catch {
      // token ausente, expirado ou com assinatura inválida
    }
    return reply.code(401).send({ error: "unauthorized" })
  })
})
