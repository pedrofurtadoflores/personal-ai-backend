import { afterAll, describe, expect, it, vi } from "vitest"

// Antes de importar o app: o env é lido no import.
vi.stubEnv("TRUST_PROXY", "loopback,linklocal,uniquelocal,100.64.0.0/10")
const { buildApp } = await import("../src/app.js")

const app = await buildApp()
app.get("/__ip", { config: { public: true } }, async (request) => request.ip)
await app.ready()

afterAll(() => app.close())

const ipFor = async (remoteAddress: string, forwardedFor: string) =>
  (await app.inject({ url: "/__ip", remoteAddress, headers: { "x-forwarded-for": forwardedFor } }))
    .body

describe("IP do cliente atrás do proxy", () => {
  it("usa o IP que o proxy da rede privada anexou, não o que o cliente inventou", async () => {
    // O cliente mandou "6.6.6.6" no header; o proxy (10.x) anexou o IP real 203.0.113.9.
    expect(await ipFor("10.0.0.1", "6.6.6.6, 203.0.113.9")).toBe("203.0.113.9")
    expect(await ipFor("100.64.0.7", "203.0.113.9")).toBe("203.0.113.9")
  })

  it("ignora X-Forwarded-For de conexões vindas da internet", async () => {
    expect(await ipFor("198.51.100.4", "6.6.6.6")).toBe("198.51.100.4")
  })
})
