import { drizzle } from "drizzle-orm/node-postgres"
import pg from "pg"
import { env } from "../config/env.js"
import * as schema from "./schema.js"

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL })

// Sem este listener, a queda de uma conexão ociosa derruba o processo.
pool.on("error", (error) => {
  console.error("Erro em conexão ociosa do Postgres:", error.message)
})

export const db = drizzle(pool, { schema, casing: "snake_case" })

export type Db = typeof db
