import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { DEFAULT_TRUSTED_PROXIES, parseEnv } from "../src/config/env.js"
import { pool } from "../src/db/client.js"
import { clientKey } from "../src/lib/client-ip.js"
import { orderedPair } from "../src/modules/sinapses/links.js"

afterAll(() => pool.end())

const validEnv = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  APP_PASSWORD_HASH: "$2b$12$" + "a".repeat(53),
  JWT_SECRET: "x".repeat(32),
  FRONTEND_URL: "https://app.example.com/",
}

describe("env", () => {
  it("aceita um ambiente válido e remove a barra final das URLs do front", () => {
    const parsed = parseEnv(validEnv)
    expect(parsed.success).toBe(true)
    expect(parsed.data?.FRONTEND_URL).toEqual(["https://app.example.com"])
  })

  it("recusa hash de senha inválido, segredo curto e TRUST_PROXY=true", () => {
    for (const override of [
      { APP_PASSWORD_HASH: "$2b$12$troque-isto" },
      { JWT_SECRET: "curto" },
      { TRUST_PROXY: "true" },
      { JWT_EXPIRES_IN: "0d" },
      { FRONTEND_URL_PATTERN: "vercel.app" },
    ]) {
      expect(parseEnv({ ...validEnv, ...override }).success, JSON.stringify(override)).toBe(false)
    }
  })

  it("em produção confia só nos proxies da rede privada por padrão", () => {
    expect(parseEnv({ ...validEnv, NODE_ENV: "production" }).data?.TRUST_PROXY).toBe(
      DEFAULT_TRUSTED_PROXIES,
    )
    expect(parseEnv(validEnv).data?.TRUST_PROXY).toBe(false)
  })
})

describe("clientKey", () => {
  it("usa o IPv4 inteiro (inclusive mapeado em IPv6)", () => {
    expect(clientKey("203.0.113.9")).toBe("203.0.113.9")
    expect(clientKey("::ffff:203.0.113.9")).toBe("203.0.113.9")
  })

  it("agrupa IPv6 pelo prefixo /64", () => {
    expect(clientKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64")
    expect(clientKey("2001:0db8:0001:0002:ffff:1:2:3")).toBe("2001:db8:1:2::/64")
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64")
    expect(clientKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64")
  })
})

describe("orderedPair", () => {
  it("recusa auto-conexão (inclusive com caixa diferente) e IDs inválidos", () => {
    const id = randomUUID()
    expect(() => orderedPair(id, id.toUpperCase())).toThrow()
    expect(() => orderedPair("a", "b")).toThrow()
  })

  it("ordena igual ao tipo uuid do Postgres, mesmo com letras maiúsculas", async () => {
    const pairs = Array.from({ length: 50 }, () => {
      const a = randomUUID()
      const b = randomUUID()
      return Math.random() < 0.5 ? [a.toUpperCase(), b] : [a, b.toUpperCase()]
    })
    for (const [a, b] of pairs) {
      const { sinapseA, sinapseB } = orderedPair(a!, b!)
      const { rows } = await pool.query<{ ok: boolean }>("select $1::uuid < $2::uuid as ok", [
        sinapseA,
        sinapseB,
      ])
      expect(rows[0]!.ok).toBe(true)
    }
  })
})
