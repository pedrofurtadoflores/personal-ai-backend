import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { buildApp } from "../src/app.js"
import { resetThrottle } from "../src/modules/auth/login-throttle.js"
import { passwordFingerprint, sessionVersion } from "../src/modules/auth/session.js"
import { bearer, login, loginToken, uniqueIp } from "./helpers.js"

const app = await buildApp()

beforeAll(() => app.ready())
afterAll(() => app.close())
beforeEach(() => resetThrottle())

const me = (headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: "/auth/me", headers })

describe("login", () => {
  it("devolve token com a senha certa", async () => {
    const response = await login(app)
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.token).toEqual(expect.any(String))
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it("recusa senha errada", async () => {
    const response = await login(app, "errada")
    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe("invalid_password")
  })

  it("recusa senha acima de 72 bytes (limite do bcrypt)", async () => {
    const response = await login(app, "a".repeat(73))
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe("validation_error")
  })

  it("bloqueia progressivamente depois de 5 falhas, mesmo com a senha certa", async () => {
    const ip = uniqueIp()
    for (let i = 0; i < 5; i++) await login(app, "errada", ip)

    const blocked = await login(app, undefined, ip)
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().error).toBe("rate_limited")
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0)

    // Outro IP continua podendo entrar.
    expect((await login(app)).statusCode).toBe(200)
  })

  it("trata todo o prefixo IPv6 /64 como um só cliente", async () => {
    for (let i = 1; i <= 5; i++) await login(app, "errada", `2001:db8:1:2::${i}`)
    const sameNetwork = await login(app, undefined, "2001:db8:1:2:ffff::99")
    expect(sameNetwork.statusCode).toBe(429)
  })
})

describe("rotas protegidas", () => {
  it("recusam requisição sem token", async () => {
    const response = await me()
    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe("unauthorized")
  })

  it("recusam token assinado com outro segredo", async () => {
    const forged =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciIsInN2IjoxLCJwZiI6IngifQ.bm9wZW5vcGVub3Blbm9wZQ"
    expect((await me(bearer(forged))).statusCode).toBe(401)
  })

  it("recusam token expirado", async () => {
    const expired = app.jwt.sign(
      { sub: "owner", sv: sessionVersion(), pf: passwordFingerprint },
      { clockTimestamp: Date.now() - 31 * 24 * 60 * 60_000 },
    )
    expect((await me(bearer(expired))).statusCode).toBe(401)
  })

  it("recusam token emitido com outra senha (troca de senha derruba as sessões)", async () => {
    const otherPassword = app.jwt.sign({ sub: "owner", sv: sessionVersion(), pf: "outra-senha" })
    expect((await me(bearer(otherPassword))).statusCode).toBe(401)
  })

  it("aceitam token válido", async () => {
    const response = await me(bearer(await loginToken(app)))
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ authenticated: true })
  })

  it("logout-all invalida todos os tokens emitidos antes", async () => {
    const oldToken = await loginToken(app)

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout-all",
      headers: bearer(oldToken),
    })
    expect(logout.statusCode).toBe(204)

    expect((await me(bearer(oldToken))).statusCode).toBe(401)
    expect((await me(bearer(await loginToken(app)))).statusCode).toBe(200)
  })
})
