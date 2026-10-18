/**
 * Backup do banco (D39): pg_dump no formato custom, enviado ao R2 em `backups/`.
 * Roda toda semana (domingo 3h) e sob demanda. Mantém os últimos KEEP backups.
 * O pg_dump vem do pacote postgresql17-client na imagem Docker.
 */
import { spawn } from "node:child_process"
import { desc, eq } from "drizzle-orm"
import { env } from "../../config/env.js"
import { db } from "../../db/client.js"
import { backups } from "../../db/schema.js"
import { HttpError } from "../../lib/http.js"
import { registerJob } from "../../lib/jobs.js"
import { r2 } from "../../lib/r2.js"

const KEEP = 8

function pgDump(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("pg_dump", [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      env.DATABASE_URL,
    ])
    const chunks: Buffer[] = []
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    child.on("error", (error) =>
      reject(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new HttpError(
              503,
              "pg_dump_missing",
              "pg_dump não está instalado neste ambiente (só existe na imagem Docker).",
            )
          : error,
      ),
    )
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`pg_dump saiu com código ${code}: ${stderr.slice(0, 500)}`)),
    )
  })
}

export async function runBackup() {
  const r2Key = `backups/personal-ai-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`
  const [row] = await db.insert(backups).values({ r2Key }).returning()
  try {
    const dump = await pgDump()
    await r2().put(r2Key, dump, "application/octet-stream")
    const [done] = await db
      .update(backups)
      .set({ status: "completed", size: dump.length, completedAt: new Date() })
      .where(eq(backups.id, row!.id))
      .returning()
    await pruneOldBackups()
    return done!
  } catch (error) {
    await db
      .update(backups)
      .set({
        status: "failed",
        error: error instanceof Error ? error.message.slice(0, 500) : "Erro",
        completedAt: new Date(),
      })
      .where(eq(backups.id, row!.id))
    throw error
  }
}

async function pruneOldBackups() {
  const completed = await db
    .select()
    .from(backups)
    .where(eq(backups.status, "completed"))
    .orderBy(desc(backups.createdAt))
  for (const old of completed.slice(KEEP)) {
    await r2().delete(old.r2Key)
    await db.delete(backups).where(eq(backups.id, old.id))
  }
}

registerJob("backups.run", async () => {
  await runBackup()
})
