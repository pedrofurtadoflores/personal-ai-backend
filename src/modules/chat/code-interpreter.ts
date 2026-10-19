/**
 * Interpretador de código (D74). Usa um container explícito por conversa, reaproveitado
 * enquanto estiver vivo (a OpenAI o apaga depois de 20 min sem uso). Os anexos da conversa e
 * do projeto são enviados para dentro dele, e os arquivos que o código cria voltam para o R2.
 * Nada fica guardado na OpenAI além da vida do container (no espírito da D55).
 */
import { toFile } from "openai"
import { openai } from "../../lib/openai.js"
import { r2 } from "../../lib/r2.js"
import type { FileRow } from "../files/service.js"

const IDLE_MINUTES = 20
const MAX_FILES = 20

type Entry = { id: string; fileIds: Set<string> }
const containers = new Map<string, Entry>()

/** Só em testes. */
export function resetContainers() {
  containers.clear()
}

async function alive(entry: Entry) {
  try {
    const container = await openai().containers.retrieve(entry.id)
    return container.status !== "expired" && container.status !== "deleted"
  } catch {
    return false
  }
}

/** Container pronto para a conversa, com os arquivos dela. `created` = conta uma sessão nova. */
export async function prepareContainer(conversationId: string, files: FileRow[]) {
  let entry = containers.get(conversationId)
  if (entry && !(await alive(entry))) entry = undefined
  let created = false
  if (!entry) {
    const container = await openai().containers.create({
      name: `personal-ai-${conversationId.slice(0, 8)}`,
      expires_after: { anchor: "last_active_at", minutes: IDLE_MINUTES },
    })
    entry = { id: container.id, fileIds: new Set() }
    containers.set(conversationId, entry)
    created = true
  }
  for (const file of files.slice(0, MAX_FILES)) {
    if (entry.fileIds.has(file.id)) continue
    const buffer = await r2().get(file.r2Key)
    await openai().containers.files.create(entry.id, {
      file: await toFile(buffer, file.name, { type: file.mime }),
    })
    entry.fileIds.add(file.id)
  }
  return { containerId: entry.id, created }
}

/** Baixa um arquivo criado pelo código dentro do container. */
export async function downloadContainerFile(containerId: string, fileId: string) {
  const response = await openai().containers.files.content.retrieve(fileId, {
    container_id: containerId,
  })
  return Buffer.from(await response.arrayBuffer())
}

const mimeByExtension: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  pdf: "application/pdf",
  html: "text/html",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
}

export const mimeFor = (name: string) =>
  mimeByExtension[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream"
