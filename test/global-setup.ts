import { fileURLToPath } from "node:url"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import pg from "pg"
import type { TestProject } from "vitest/node"

/** Cria o banco de teste (se não existir) e aplica as migrations. */
export default async function setup(project: TestProject) {
  const url = new URL(project.config.env.DATABASE_URL!)
  const database = url.pathname.slice(1)

  const adminUrl = new URL(url)
  adminUrl.pathname = "/postgres"
  const admin = new pg.Client({ connectionString: adminUrl.toString() })
  await admin.connect()
  const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [database])
  if (!rowCount) await admin.query(`create database "${database}"`)
  await admin.end()

  const pool = new pg.Pool({ connectionString: url.toString() })
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  })
  await pool.end()
}
