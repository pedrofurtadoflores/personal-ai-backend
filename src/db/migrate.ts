import { fileURLToPath } from "node:url"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { db, pool } from "./client.js"

// A extensão pgvector é criada pela própria migration 0000.
await migrate(db, {
  migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
})
await pool.end()

console.log("Migrations aplicadas.")
