import { randomUUID } from "node:crypto"
import { and, eq, isNull } from "drizzle-orm"
import { db } from "../../db/client.js"
import { fileChunks, files, generatedImages } from "../../db/schema.js"
import { chunkText } from "../../lib/chunk.js"
import { embed } from "../../lib/embeddings.js"
import { HttpError, notFound } from "../../lib/http.js"
import { enqueue, registerJob } from "../../lib/jobs.js"
import { r2 } from "../../lib/r2.js"
import { extractFileText, isSupported, MAX_UPLOAD_BYTES } from "./extract.js"

export type FileRow = typeof files.$inferSelect

const safeName = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(-120) || "arquivo"

const keyFor = (prefix: string, name: string) => {
  const now = new Date()
  const month = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`
  return `${prefix}/${month}/${randomUUID()}-${safeName(name)}`
}

export async function getFile(id: string) {
  const [row] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), isNull(files.deletedAt)))
  if (!row) throw notFound("Arquivo")
  return row
}

/** Passo 1 do upload: registra o arquivo e devolve a URL assinada para o PUT direto no R2. */
export async function createUpload(input: {
  name: string
  mime: string
  size: number
  conversationId?: string | null
  folderId?: string | null
}) {
  if (input.size > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, "payload_too_large", "O limite é de 50 MB por arquivo.")
  }
  if (!isSupported(input.mime, input.name)) {
    throw new HttpError(415, "unsupported_media_type", "Tipo de arquivo não suportado.")
  }
  const r2Key = keyFor("uploads", input.name)
  const uploadUrl = await r2().presignPut(r2Key, input.mime, input.size)
  const [row] = await db
    .insert(files)
    .values({
      r2Key,
      name: input.name.slice(0, 200),
      mime: input.mime,
      size: input.size,
      conversationId: input.conversationId ?? null,
      folderId: input.folderId ?? null,
    })
    .returning()
  return { file: row!, uploadUrl }
}

/** Passo 2: confere que o objeto chegou no R2 e manda processar (texto + embeddings). */
export async function completeUpload(id: string) {
  const file = await getFile(id)
  const head = await r2().head(file.r2Key)
  if (!head) throw new HttpError(409, "upload_missing", "O arquivo não chegou no armazenamento.")
  const [row] = await db
    .update(files)
    .set({ status: "uploaded", size: head.size })
    .where(eq(files.id, id))
    .returning()
  await enqueue("files.process", { fileId: id })
  return row!
}

/** Job: extrai o texto, divide em pedaços e gera embeddings (para o RAG e a busca). */
export async function processFile(fileId: string) {
  const file = await getFile(fileId)
  await db.update(files).set({ status: "processing", error: null }).where(eq(files.id, fileId))
  try {
    const buffer = await r2().get(file.r2Key)
    const text = await extractFileText(buffer, file.mime, file.name)
    await db.delete(fileChunks).where(eq(fileChunks.fileId, fileId))
    if (text) {
      const pieces = chunkText(text)
      if (pieces.length) {
        const { model, vectors } = await embed(pieces.map((piece) => `${file.name}\n\n${piece}`))
        await db.insert(fileChunks).values(
          pieces.map((piece, idx) => ({
            fileId,
            idx,
            text: piece,
            embeddingModel: model,
            embedding: vectors[idx]!,
          })),
        )
      }
    }
    await db.update(files).set({ status: "ready", extractedText: text }).where(eq(files.id, fileId))
  } catch (error) {
    await db
      .update(files)
      .set({
        status: "error",
        error: error instanceof Error ? error.message.slice(0, 500) : "Erro",
      })
      .where(eq(files.id, fileId))
    throw error
  }
}

registerJob<{ fileId: string }>("files.process", ({ fileId }) => processFile(fileId))

/** Imagem gerada pela tool de imagem: vai para o R2 e para a galeria. */
export async function saveGeneratedImage(params: {
  base64: string
  format: string
  prompt: string | null
  messageId: string
  conversationId: string
}) {
  const mime = `image/${params.format === "jpeg" ? "jpeg" : params.format}`
  const buffer = Buffer.from(params.base64, "base64")
  const r2Key = keyFor("generated", `imagem.${params.format}`)
  await r2().put(r2Key, buffer, mime)
  const [file] = await db
    .insert(files)
    .values({
      r2Key,
      name: `imagem-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${params.format}`,
      mime,
      size: buffer.length,
      origin: "generated",
      conversationId: params.conversationId,
      status: "ready",
    })
    .returning()
  await db
    .insert(generatedImages)
    .values({ fileId: file!.id, messageId: params.messageId, prompt: params.prompt ?? "" })
  return file!
}

/** Arquivo criado pelo interpretador de código (D74): vai para o R2 como "gerado". */
export async function saveGeneratedFile(params: {
  buffer: Buffer
  name: string
  mime: string
  conversationId: string
}) {
  const r2Key = keyFor("generated", params.name)
  await r2().put(r2Key, params.buffer, params.mime)
  const [file] = await db
    .insert(files)
    .values({
      r2Key,
      name: params.name.slice(0, 200),
      mime: params.mime,
      size: params.buffer.length,
      origin: "generated",
      conversationId: params.conversationId,
      status: "ready",
    })
    .returning()
  return file!
}

export async function fileUrl(file: FileRow, download = false) {
  return r2().presignGet(file.r2Key, download ? { downloadName: file.name } : {})
}
