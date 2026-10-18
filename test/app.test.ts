import { readFile } from "node:fs/promises"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { buildApp } from "../src/app.js"
import { db } from "../src/db/client.js"

const app = await buildApp()

beforeAll(() => app.ready())
afterAll(() => app.close())

describe("health", () => {
  it("responde ok com o banco conectado", async () => {
    const response = await app.inject({ method: "GET", url: "/health" })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: "ok", db: "ok" })
  })

  it("responde 503 quando o banco não responde", async () => {
    vi.spyOn(db, "execute").mockRejectedValueOnce(new Error("connection timeout"))
    const response = await app.inject({ method: "GET", url: "/health" })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: "degraded", db: "down" })
  })
})

describe("erros", () => {
  it("rota inexistente responde 404, não 401", async () => {
    const response = await app.inject({ method: "GET", url: "/nao-existe" })
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe("not_found")
  })

  it("JSON malformado usa o formato padrão, com mensagem própria em pt-BR", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{ruim",
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: "invalid_json",
      message: "O corpo da requisição não é um JSON válido.",
    })
  })
})

describe("headers de segurança", () => {
  it("toda resposta sai com nosniff, noindex e sem enquadramento", async () => {
    const response = await app.inject({ method: "GET", url: "/health" })
    expect(response.headers["x-content-type-options"]).toBe("nosniff")
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow")
    expect(response.headers["x-frame-options"]).toBe("DENY")
  })
})

describe("CORS", () => {
  const preflight = (origin: string, method = "DELETE") =>
    app.inject({
      method: "OPTIONS",
      url: "/auth/me",
      headers: { origin, "access-control-request-method": method },
    })

  it("libera PATCH e DELETE para o frontend", async () => {
    const response = await preflight("http://localhost:3000")
    expect(response.statusCode).toBe(204)
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000")
    expect(response.headers["access-control-allow-methods"]).toContain("PATCH")
    expect(response.headers["access-control-allow-methods"]).toContain("DELETE")
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined()
  })

  it("libera os previews da Vercel que casam com FRONTEND_URL_PATTERN", async () => {
    const origin = "https://personal-ai-frontend-git-feat-x-pedro.vercel.app"
    const response = await preflight(origin)
    expect(response.headers["access-control-allow-origin"]).toBe(origin)
  })

  it("não libera outras origens", async () => {
    for (const origin of [
      "https://evil.example",
      "https://personal-ai-frontend-x.vercel.app.evil",
    ]) {
      const response = await preflight(origin, "GET")
      expect(response.headers["access-control-allow-origin"]).toBeUndefined()
    }
  })
})

describe("documentação", () => {
  it("o Swagger UI abre sem token fora de produção", async () => {
    const response = await app.inject({ method: "GET", url: "/docs/json" })
    expect(response.statusCode).toBe(200)
  })

  it("openapi.json versionado está igual ao gerado pelas rotas", async () => {
    // Se falhar: rode `npm run openapi:export` e faça commit do openapi.json.
    const committed = JSON.parse(
      await readFile(new URL("../openapi.json", import.meta.url), "utf8"),
    ) as unknown
    expect(app.swagger()).toEqual(committed)
  })

  it("declara as respostas de erro das rotas protegidas", async () => {
    const responses = app.swagger().paths?.["/auth/me"]?.get?.responses ?? {}
    expect(Object.keys(responses)).toEqual(
      expect.arrayContaining(["200", "400", "401", "429", "500"]),
    )
  })
})
