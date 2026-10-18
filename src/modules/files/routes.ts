import { and, desc, eq, isNull } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { files, generatedImages } from "../../db/schema.js"
import { withErrors } from "../../lib/http.js"
import { enqueue } from "../../lib/jobs.js"
import { isoDate, jsonDates } from "../../lib/serialize.js"
import { MAX_UPLOAD_BYTES } from "./extract.js"
import { completeUpload, createUpload, fileUrl, getFile, type FileRow } from "./service.js"

const id = z.uuid()

export const fileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  origin: z.enum(["upload", "generated"]),
  conversationId: z.string().nullable(),
  status: z.enum(["pending", "uploaded", "processing", "ready", "error"]),
  error: z.string().nullable(),
  hasText: z.boolean(),
  createdAt: isoDate,
})

export const toFile = (row: FileRow) =>
  fileSchema.parse(jsonDates({ ...row, hasText: Boolean(row.extractedText) }))

export const fileRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/files",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["files"],
        summary: "Iniciar upload: devolve a URL assinada para o PUT direto no R2",
        body: z.object({
          name: z.string().trim().min(1).max(200),
          mime: z.string().min(1).max(200),
          size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
          conversationId: id.nullable().optional(),
        }),
        response: withErrors({ 201: z.object({ file: fileSchema, uploadUrl: z.string() }) }),
      },
    },
    async (request, reply) => {
      const { file, uploadUrl } = await createUpload(request.body)
      return reply.code(201).send({ file: toFile(file), uploadUrl })
    },
  )

  app.post(
    "/files/:id/complete",
    {
      schema: {
        tags: ["files"],
        summary: "Confirmar que o upload terminou (dispara o processamento)",
        params: z.object({ id }),
        response: withErrors({ 200: fileSchema }),
      },
    },
    async (request) => toFile(await completeUpload(request.params.id)),
  )

  app.get(
    "/files",
    {
      schema: {
        tags: ["files"],
        summary: "Listar arquivos (enviados e gerados)",
        querystring: z.object({
          origin: z.enum(["upload", "generated"]).optional(),
          conversationId: id.optional(),
        }),
        response: withErrors({ 200: z.object({ files: z.array(fileSchema) }) }),
      },
    },
    async (request) => {
      const rows = await db
        .select()
        .from(files)
        .where(
          and(
            isNull(files.deletedAt),
            request.query.origin ? eq(files.origin, request.query.origin) : undefined,
            request.query.conversationId
              ? eq(files.conversationId, request.query.conversationId)
              : undefined,
          ),
        )
        .orderBy(desc(files.createdAt))
        .limit(500)
      return { files: rows.map(toFile) }
    },
  )

  app.get(
    "/files/:id",
    {
      schema: {
        tags: ["files"],
        summary: "Arquivo com URL assinada de visualização (1 h) e o texto extraído",
        params: z.object({ id }),
        querystring: z.object({ download: z.stringbool().default(false) }),
        response: withErrors({
          200: z.object({
            file: fileSchema,
            url: z.string(),
            extractedText: z.string().nullable(),
          }),
        }),
      },
    },
    async (request) => {
      const file = await getFile(request.params.id)
      return {
        file: toFile(file),
        url: await fileUrl(file, request.query.download),
        extractedText: file.extractedText,
      }
    },
  )

  app.post(
    "/files/:id/reprocess",
    {
      schema: {
        tags: ["files"],
        summary: "Processar de novo (ex.: depois de um erro)",
        params: z.object({ id }),
        response: withErrors({ 202: z.object({ queued: z.literal(true) }) }),
      },
    },
    async (request, reply) => {
      await getFile(request.params.id)
      await enqueue("files.process", { fileId: request.params.id })
      return reply.code(202).send({ queued: true as const })
    },
  )

  app.delete(
    "/files/:id",
    {
      schema: {
        tags: ["files"],
        summary: "Apagar arquivo (soft delete; o objeto continua no R2)",
        params: z.object({ id }),
        response: withErrors({ 204: z.null() }),
      },
    },
    async (request, reply) => {
      await getFile(request.params.id)
      await db.update(files).set({ deletedAt: new Date() }).where(eq(files.id, request.params.id))
      return reply.code(204).send(null)
    },
  )

  app.get(
    "/images",
    {
      schema: {
        tags: ["files"],
        summary: "Galeria de imagens geradas",
        response: withErrors({
          200: z.object({
            images: z.array(
              z.object({
                fileId: z.string(),
                prompt: z.string(),
                messageId: z.string().nullable(),
                conversationId: z.string().nullable(),
                url: z.string(),
                createdAt: isoDate,
              }),
            ),
          }),
        }),
      },
    },
    async () => {
      const rows = await db
        .select({
          file: files,
          prompt: generatedImages.prompt,
          messageId: generatedImages.messageId,
          createdAt: generatedImages.createdAt,
        })
        .from(generatedImages)
        .innerJoin(files, eq(files.id, generatedImages.fileId))
        .where(isNull(files.deletedAt))
        .orderBy(desc(generatedImages.createdAt))
        .limit(200)
      const images = await Promise.all(
        rows.map(async (row) => ({
          fileId: row.file.id,
          prompt: row.prompt,
          messageId: row.messageId,
          conversationId: row.file.conversationId,
          url: await fileUrl(row.file),
          createdAt: row.createdAt.toISOString(),
        })),
      )
      return { images }
    },
  )
}
