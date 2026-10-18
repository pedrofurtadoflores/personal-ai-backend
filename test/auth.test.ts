import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { buildApp } from "../src/app.js"
import { resetThrottle } from "../src/modules/auth/login-throttle.js"
import { login, loginToken, uniqueIp } from "./helpers.js"

const app = await buildApp()

beforeAll(() => app.ready())
afterAll(() => app.close())
beforeEach(() => resetThrottle())

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
    expect(response.json()).toEqual({ error: "invalid_password" })
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
})

describe("rotas protegidas", () => {
  it("recusam requisição sem token", async () => {
    const response = await app.inject({ method: "GET", url: "/auth/me" })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: "unauthorized" })
  })

  it("recusam token assinado com outro segredo", async () => {
    const forged =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciIsInN2IjoxLCJwZiI6IngifQ.bm9wZW5vcGVub3Blbm9wZQ"
    const response = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${forged}` },
    })
    expect(response.statusCode).toBe(401)
  })

  it("aceitam token válido", async () => {
    const token = await loginToken(app)
    const response = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ authenticated: true })
  })

  it("logout-all invalida todos os tokens emitidos antes", async () => {
    const oldToken = await loginToken(app)
    const auth = { authorization: `Bearer ${oldToken}` }

    const logout = await app.inject({ method: "POST", url: "/auth/logout-all", headers: auth })
    expect(logout.statusCode).toBe(204)

    const stale = await app.inject({ method: "GET", url: "/auth/me", headers: auth })
    expect(stale.statusCode).toBe(401)

    const newToken = await loginToken(app)
    const fresh = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${newToken}` },
    })
    expect(fresh.statusCode).toBe(200)
  })
})
