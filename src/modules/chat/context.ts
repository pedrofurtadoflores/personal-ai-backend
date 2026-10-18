import { and, cosineDistance, inArray, isNull, sql } from "drizzle-orm"
import type { ResponseInputItem } from "openai/resources/responses/responses"
import { db } from "../../db/client.js"
import { fileChunks, files } from "../../db/schema.js"
import { truncate } from "../../lib/chunk.js"
import { embedOne } from "../../lib/embeddings.js"
import { r2 } from "../../lib/r2.js"
import type { Conversation, Message } from "../conversations/service.js"
import type { AppSettings } from "../settings/service.js"
import {
  ensureAboutMe,
  pinnedSinapses,
  searchSinapseChunks,
  sinapseIndex,
} from "../sinapses/service.js"
import type { MessagePart } from "./parts.js"

const MAX_PINNED_CHARS = 6_000
const MAX_FILE_TEXT_CHARS = 60_000
/** Anexos binários (imagem/PDF) vão inteiros só nas últimas mensagens; antes disso, via RAG. */
const FULL_ATTACHMENT_TURNS = 3

const aggressivenessGuide: Record<AppSettings["sinapsesAggressiveness"], string> = {
  conservative:
    "Só registre na memória fatos claramente duradouros que o usuário afirmou sobre si, decisões e pedidos explícitos para lembrar.",
  balanced:
    "Registre na memória fatos duradouros, preferências, decisões, ideias de projeto e reflexões que valha a pena lembrar daqui a meses. Ignore o que é passageiro.",
  liberal:
    "Registre na memória tudo que possa ser útil no futuro (o usuário prefere guardar mais e limpar depois).",
}

/**
 * Instruções estáveis (D41): mudam pouco entre chamadas, então ficam no começo e
 * aproveitam o cache de prompt. Nada que muda a cada mensagem entra aqui.
 */
export async function buildInstructions(conversation: Conversation, settings: AppSettings) {
  const today = new Date().toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
  const parts = [
    "Você é o assistente pessoal do usuário, num app de uso exclusivo dele. Responda em pt-BR, a menos que ele peça outro idioma.",
    "Use markdown: títulos curtos, listas, tabelas e blocos de código com a linguagem indicada. Fórmulas em LaTeX ($...$ ou $$...$$). Diagramas em blocos ```mermaid. Nunca use HTML.",
    `Hoje é ${today}.`,
  ]
  if (settings.customInstructions.trim()) {
    parts.push(`## Instruções do usuário\n\n${settings.customInstructions.trim()}`)
  }
  if (conversation.systemPrompt?.trim()) {
    parts.push(`## Instruções desta conversa\n\n${conversation.systemPrompt.trim()}`)
  }

  if (conversation.anonymous) {
    parts.push("Esta é uma conversa anônima: não há memória disponível e nada será guardado.")
    return parts.join("\n\n")
  }

  await ensureAboutMe()
  const [pinned, index] = await Promise.all([pinnedSinapses(), sinapseIndex()])
  parts.push(
    "## Memória (Sinapses)",
    "Você tem uma memória de longo prazo organizada em sinapses (blocos de conhecimento por tema, em markdown). " +
      "Use as ferramentas `search_sinapses` e `read_sinapse` quando o assunto puder ter algo guardado. " +
      `${aggressivenessGuide[settings.sinapsesAggressiveness]} ` +
      "Para guardar, prefira atualizar uma sinapse existente do mesmo tema (`update_sinapse`) a criar outra; crie (`create_sinapse`) só para temas novos. " +
      "Escreva sempre em pt-BR, em terceira pessoa sobre o usuário, de forma objetiva. Não avise que vai guardar; apenas guarde.",
  )
  for (const sinapse of pinned) {
    parts.push(
      `### ${sinapse.emoji ?? "📌"} ${sinapse.title} (fixada, id ${sinapse.id})\n\n${truncate(sinapse.content, MAX_PINNED_CHARS)}`,
    )
  }
  if (index.length) {
    parts.push(
      "### Índice de sinapses\n\n" +
        index.map((item) => `- ${item.title} (id ${item.id}): ${item.summary}`).join("\n"),
    )
  }
  return parts.join("\n\n")
}

type FileRow = typeof files.$inferSelect

async function loadFiles(branch: Message[]) {
  const ids = branch.flatMap((message) =>
    (message.content as MessagePart[])
      .filter((part) => part.type === "file")
      .map((part) => part.fileId),
  )
  if (!ids.length) return new Map<string, FileRow>()
  const rows = await db
    .select()
    .from(files)
    .where(and(inArray(files.id, ids), isNull(files.deletedAt)))
  return new Map(rows.map((row) => [row.id, row]))
}

async function fileToInput(
  file: FileRow,
  full: boolean,
): Promise<ResponseInputItem.Message["content"][number] | null> {
  if (!full) {
    return { type: "input_text", text: `[Arquivo anexado antes: ${file.name}]` }
  }
  if (file.mime.startsWith("image/")) {
    // A OpenAI baixa a imagem pela URL assinada (válida por 1 h).
    const url = await r2().presignGet(file.r2Key)
    return { type: "input_image", image_url: url, detail: "auto" }
  }
  if (file.mime === "application/pdf") {
    const data = (await r2().get(file.r2Key)).toString("base64")
    return {
      type: "input_file",
      filename: file.name,
      file_data: `data:application/pdf;base64,${data}`,
    }
  }
  if (file.extractedText) {
    return {
      type: "input_text",
      text: `Conteúdo do arquivo "${file.name}":\n\n${truncate(file.extractedText, MAX_FILE_TEXT_CHARS)}`,
    }
  }
  return { type: "input_text", text: `[Arquivo "${file.name}" ainda sendo processado]` }
}

/** Histórico do ramo no formato da Responses API. */
export async function buildInput(branch: Message[]) {
  const filesById = await loadFiles(branch)
  const userTurns = branch.filter((message) => message.role === "user")
  const recentUserIds = new Set(
    userTurns.slice(-FULL_ATTACHMENT_TURNS).map((message) => message.id),
  )
  const input: ResponseInputItem[] = []
  let hasAttachments = false

  for (const message of branch) {
    const parts = message.content as MessagePart[]
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n")
    if (message.role === "assistant") {
      if (text) input.push({ role: "assistant", content: text })
      continue
    }
    if (message.role !== "user") continue

    const content: ResponseInputItem.Message["content"] = []
    for (const part of parts) {
      if (part.type !== "file") continue
      const file = filesById.get(part.fileId)
      if (!file) continue
      hasAttachments = true
      const item = await fileToInput(file, recentUserIds.has(message.id))
      if (item) content.push(item)
    }
    if (text) content.push({ type: "input_text", text })
    if (content.length) input.push({ type: "message", role: "user", content })
  }
  return { input, hasAttachments }
}

/**
 * Memória relevante para a última mensagem (RAG). Vai como mensagem de desenvolvedor logo
 * antes da última pergunta, para não quebrar o cache do prefixo (D41).
 */
export async function retrieveContext(conversation: Conversation, query: string) {
  const empty = { text: null as string | null, part: null as MessagePart | null, usedFiles: false }
  if (conversation.anonymous || !query.trim()) return empty

  const { vector } = await embedOne(query)
  const sinapseHits = await searchSinapseChunks(vector, { limit: 6, minScore: 0.35 })

  const distance = cosineDistance(fileChunks.embedding, vector)
  const fileHits = await db
    .select({
      fileId: fileChunks.fileId,
      name: files.name,
      text: fileChunks.text,
      score: sql<number>`1 - (${distance})`,
    })
    .from(fileChunks)
    .innerJoin(files, sql`${files.id} = ${fileChunks.fileId}`)
    .where(and(sql`${files.conversationId} = ${conversation.id}`, isNull(files.deletedAt)))
    .orderBy(distance)
    .limit(4)
  const relevantFiles = fileHits.filter((hit) => hit.score >= 0.35)

  if (!sinapseHits.length && !relevantFiles.length) return empty

  const sections: string[] = []
  if (sinapseHits.length) {
    sections.push(
      "Trechos da memória que podem ser relevantes:\n\n" +
        sinapseHits
          .map((hit) => `[${hit.title} · id ${hit.sinapseId}]\n${hit.text}`)
          .join("\n\n---\n\n"),
    )
  }
  if (relevantFiles.length) {
    sections.push(
      "Trechos de arquivos desta conversa:\n\n" +
        relevantFiles.map((hit) => `[${hit.name}]\n${hit.text}`).join("\n\n---\n\n"),
    )
  }

  const uniqueSinapses = [
    ...new Map(
      sinapseHits.map((hit) => [hit.sinapseId, { id: hit.sinapseId, title: hit.title }]),
    ).values(),
  ]
  const uniqueFiles = [
    ...new Map(
      relevantFiles.map((hit) => [hit.fileId, { id: hit.fileId, name: hit.name }]),
    ).values(),
  ]
  return {
    text: sections.join("\n\n"),
    part: { type: "context", sinapses: uniqueSinapses, files: uniqueFiles } satisfies MessagePart,
    usedFiles: relevantFiles.length > 0,
  }
}
