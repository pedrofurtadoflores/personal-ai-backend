import { drizzle } from "drizzle-orm/node-postgres"
import pg from "pg"
import { env } from "../config/env.js"
import * as schema from "./schema.js"

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  // Sem timeouts, uma rede sem resposta deixaria /health e as rotas pendurados para sempre.
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
  idle_in_transaction_session_timeout: 30_000,
})

// Sem este listener, a queda de uma conexão ociosa derruba o processo.
pool.on("error", (error) => {
  console.error("Erro em conexão ociosa do Postgres:", error.message)
})

export const db = drizzle(pool, { schema, casing: "snake_case" })

export type Db = typeof db
