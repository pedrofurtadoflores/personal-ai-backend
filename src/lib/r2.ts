/**
 * Cloudflare R2 (API compatível com S3). Upload e download direto do navegador com
 * URLs assinadas: o arquivo não passa pelo backend (seção 3 do plano).
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { env } from "../config/env.js"
import { HttpError } from "./http.js"

export interface Storage {
  presignPut(key: string, mime: string, size: number): Promise<string>
  presignGet(key: string, options?: { downloadName?: string; expiresIn?: number }): Promise<string>
  head(key: string): Promise<{ size: number } | null>
  get(key: string): Promise<Buffer>
  put(key: string, body: Buffer, mime: string): Promise<void>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<{ key: string; lastModified?: Date }[]>
  publicOrigin(): string
}

const UPLOAD_URL_TTL = 10 * 60
const DOWNLOAD_URL_TTL = 60 * 60

function createR2Storage(): Storage {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw new HttpError(503, "storage_not_configured", "O R2 não está configurado.")
  }
  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  const s3 = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  })
  const Bucket = R2_BUCKET

  return {
    presignPut: (key, mime, size) =>
      getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket, Key: key, ContentType: mime, ContentLength: size }),
        { expiresIn: UPLOAD_URL_TTL },
      ),
    presignGet: (key, options = {}) =>
      getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ...(options.downloadName
            ? {
                ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(options.downloadName)}`,
              }
            : {}),
        }),
        { expiresIn: options.expiresIn ?? DOWNLOAD_URL_TTL },
      ),
    async head(key) {
      try {
        const result = await s3.send(new HeadObjectCommand({ Bucket, Key: key }))
        return { size: result.ContentLength ?? 0 }
      } catch {
        return null
      }
    },
    async get(key) {
      const result = await s3.send(new GetObjectCommand({ Bucket, Key: key }))
      return Buffer.from(await result.Body!.transformToByteArray())
    },
    async put(key, body, mime) {
      await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: mime }))
    },
    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket, Key: key }))
    },
    async list(prefix) {
      const result = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix }))
      return (result.Contents ?? []).map((item) => ({
        key: item.Key!,
        lastModified: item.LastModified,
      }))
    },
    publicOrigin: () => `https://${Bucket}.${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  }
}

let storage: Storage | undefined

export function r2(): Storage {
  storage ??= createR2Storage()
  return storage
}

/** Só para testes: troca o armazenamento por um falso. */
export function setStorage(fake: Storage | undefined) {
  storage = fake
}

/**
 * CORS do bucket (D40): o navegador faz PUT direto com a URL assinada.
 * Precisa de um token do R2 com permissão de administrar o bucket.
 */
export async function configureBucketCors(origins: string[]) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw new HttpError(503, "storage_not_configured", "O R2 não está configurado.")
  }
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  })
  await s3
    .send(
      new PutBucketCorsCommand({
        Bucket: R2_BUCKET,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: origins,
              AllowedMethods: ["GET", "PUT", "HEAD"],
              AllowedHeaders: ["content-type"],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    )
    .catch((error: { name?: string }) => {
      if (error.name === "AccessDenied") {
        throw new HttpError(
          403,
          "storage_forbidden",
          "O token do R2 não tem permissão para alterar o CORS do bucket. Configure no painel da Cloudflare (R2 → bucket → Settings → CORS Policy).",
        )
      }
      throw error
    })
}
