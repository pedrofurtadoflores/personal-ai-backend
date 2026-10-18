import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { orderedPair } from "../src/db/schema.js"
import { buildApp } from "../src/app.js"

const app = await buildApp()

beforeAll(() => app.ready())
afterAll(() => app.close())

describe("health", () => {
  it("responde ok com o banco conectado", async () => {
    const response = await app.inject({ method: "GET", url: "/health" })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: "ok", db: "ok" })
  })
})

describe("erros", () => {
  it("rota inexistente responde 404, não 401", async () => {
    const response = await app.inject({ method: "GET", url: "/nao-existe" })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: "not_found" })
  })

  it("JSON malformado usa o formato padrão de erro", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{ruim",
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe("invalid_json")
  })
})

describe("CORS", () => {
  it("libera PATCH e DELETE para o frontend", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/auth/me",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "DELETE",
      },
    })
    expect(response.statusCode).toBe(204)
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000")
    expect(response.headers["access-control-allow-methods"]).toContain("PATCH")
    expect(response.headers["access-control-allow-methods"]).toContain("DELETE")
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined()
  })

  it("não libera outras origens", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/auth/me",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    })
    expect(response.headers["access-control-allow-origin"]).toBeUndefined()
  })
})

describe("openapi", () => {
  it("publica o contrato da API fora de produção", async () => {
    const response = await app.inject({ method: "GET", url: "/openapi.json" })
    expect(response.statusCode).toBe(200)
    expect(Object.keys(response.json().paths)).toContain("/auth/login")
  })
})

describe("orderedPair", () => {
  it("normaliza a ordem e recusa auto-conexão", () => {
    expect(orderedPair("b", "a")).toEqual({ sinapseA: "a", sinapseB: "b" })
    expect(() => orderedPair("a", "a")).toThrow()
  })
})
