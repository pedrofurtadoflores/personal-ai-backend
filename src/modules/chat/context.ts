import { and, cosineDistance, eq, inArray, isNull, or, sql } from "drizzle-orm"
import type { ResponseInputItem } from "openai/resources/responses/responses"
import { db } from "../../db/client.js"
import { fileChunks, files, folders, sinapses } from "../../db/schema.js"
import { truncate } from "../../lib/chunk.js"
import { embedOne } from "../../lib/embeddings.js"
import { r2 } from "../../lib/r2.js"
import type { Conversation, Message } from "../conversations/service.js"
import { isSpreadsheet } from "../files/extract.js"
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
const MAX_MENTION_CHARS = 12_000
/** Anexos binários (imagem/PDF) e menções vão inteiros só nas últimas mensagens; antes, via RAG. */
const FULL_ATTACHMENT_TURNS = 3

const aggressivenessGuide: Record<AppSettings["sinapsesAggressiveness"], string> = {
  conservative:
    "Só registre na memória fatos claramente duradouros que o usuário afirmou sobre si, decisões e pedidos explícitos para lembrar.",
  balanced:
    "Registre na memória fatos duradouros, preferências, decisões, ideias de projeto e reflexões que valha a pena lembrar daqui a meses. Ignore o que é passageiro.",
  liberal:
    "Registre na memória tudo que possa ser útil no futuro (o usuário prefere guardar mais e limpar depois).",
}

export type Folder = typeof folders.$inferSelect

export async function folderOf(conversation: Conversation) {
  if (!conversation.folderId) return null
  const [folder] = await db.select().from(folders).where(eq(folders.id, conversation.folderId))
  return folder ?? null
}

/**
 * Instruções estáveis (D41): mudam pouco entre chamadas, então ficam no começo e
 * aproveitam o cache de prompt. Nada que muda a cada mensagem entra aqui.
 */
export async function buildInstructions(
  conversation: Conversation,
  settings: AppSettings,
  folder: Folder | null = null,
) {
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
    "Se o usuário mandar um link, use `fetch_url` para ler a página antes de responder sobre ela.",
    `Hoje é ${today}.`,
  ]
  if (settings.customInstructions.trim()) {
    parts.push(`## Instruções do usuário\n\n${settings.customInstructions.trim()}`)
  }
  if (folder) {
    parts.push(
      `## Projeto: ${folder.name}\n\nEsta conversa faz parte do projeto "${folder.name}".` +
        (folder.instructions.trim() ? `\n\n${folder.instructions.trim()}` : ""),
    )
  }
  if (conversation.systemPrompt?.trim()) {
    parts.push(`## Instruções desta conversa\n\n${conversation.systemPrompt.trim()}`)
  }

  if (conversation.anonymous) {
    parts.push("Esta é uma conversa anônima: não há memória disponível e nada será guardado.")
    return parts.join("\n\n")
  }

  await ensureAboutMe()
  const [pinned, index, projectSinapses] = await Promise.all([
    pinnedSinapses(),
    sinapseIndex(),
    folder?.sinapseIds.length
      ? db
          .select()
          .from(sinapses)
          .where(
            and(
              inArray(sinapses.id, folder.sinapseIds),
              eq(sinapses.status, "active"),
              isNull(sinapses.deletedAt),
            ),
          )
      : Promise.resolve([]),
  ])
  parts.push(
    "## Memória (Sinapses)",
    "Você tem uma memória de longo prazo organizada em sinapses (blocos de conhecimento por tema, em markdown). " +
      "Use as ferramentas `search_sinapses` e `read_sinapse` quando o assunto puder ter algo guardado. " +
      `${aggressivenessGuide[settings.sinapsesAggressiveness]} ` +
      "Para guardar, prefira atualizar uma sinapse existente do mesmo tema (`update_sinapse`) a criar outra; crie (`create_sinapse`) só para temas novos. " +
      "Escreva sempre em pt-BR, em terceira pessoa sobre o usuário, de forma objetiva. Não avise que vai guardar; apenas guarde.",
  )
  const pinnedIds = new Set(pinned.map((sinapse) => sinapse.id))
  for (const sinapse of pinned) {
    parts.push(
      `### ${sinapse.emoji ?? "📌"} ${sinapse.title} (fixada, id ${sinapse.id})\n\n${truncate(sinapse.content, MAX_PINNED_CHARS)}`,
    )
  }
  for (const sinapse of projectSinapses) {
    if (pinnedIds.has(sinapse.id)) continue
    parts.push(
      `### ${sinapse.emoji ?? "📁"} ${sinapse.title} (do projeto, id ${sinapse.id})\n\n${truncate(sinapse.content, MAX_PINNED_CHARS)}`,
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

/** Ids de arquivo citados no ramo (anexos, imagens geradas, arquivos do interpretador). */
export function branchFileIds(branch: Message[]) {
  return [
    ...new Set(
      branch.flatMap((message) =>
        (message.content as MessagePart[]).flatMap((part) =>
          part.type === "file" || part.type === "image" ? [part.fileId] : [],
        ),
      ),
    ),
  ]
}

async function loadFiles(branch: Message[]) {
  const ids = branchFileIds(branch)
  if (!ids.length) return new Map<string, FileRow>()
  const rows = await db
    .select()
    .from(files)
    .where(and(inArray(files.id, ids), isNull(files.deletedAt)))
  return new Map(rows.map((row) => [row.id, row]))
}

async function loadMentions(branch: Message[]) {
  const ids = [
    ...new Set(
      branch.flatMap((message) =>
        (message.content as MessagePart[]).flatMap((part) =>
          part.type === "mention" ? [part.sinapseId] : [],
        ),
      ),
    ),
  ]
  if (!ids.length) return new Map<string, { title: string; content: string }>()
  const rows = await db
    .select({ id: sinapses.id, title: sinapses.title, content: sinapses.content })
    .from(sinapses)
    .where(and(inArray(sinapses.id, ids), isNull(sinapses.deletedAt)))
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
  if (["pending", "uploaded", "processing"].includes(file.status)) {
    return { type: "input_text", text: `[Arquivo "${file.name}" ainda sendo processado]` }
  }
  if (isSpreadsheet(file.mime, file.name)) {
    return {
      type: "input_text",
      text: `[Planilha "${file.name}" anexada: só o interpretador de código consegue ler o conteúdo dela.]`,
    }
  }
  return { type: "input_text", text: `[Arquivo "${file.name}" anexado, sem texto legível]` }
}

/** Notas que acompanham a resposta antiga no histórico: fontes, imagens e arquivos gerados (1d). */
function assistantNotes(parts: MessagePart[]) {
  const notes: string[] = []
  for (const part of parts) {
    if (part.type === "sources" && part.items.length) {
      notes.push(
        "Fontes citadas nesta resposta:\n" +
          part.items.map((item, index) => `[${index + 1}] ${item.title} — ${item.url}`).join("\n"),
      )
    }
    if (part.type === "image") notes.push(`[Imagem gerada: ${part.prompt ?? "sem descrição"}]`)
    if (part.type === "file") notes.push(`[Arquivo gerado pelo código: ${part.name}]`)
  }
  return notes
}

/** Histórico do ramo no formato da Responses API. */
export async function buildInput(branch: Message[]) {
  const [filesById, mentions] = await Promise.all([loadFiles(branch), loadMentions(branch)])
  const userTurns = branch.filter((message) => message.role === "user")
  const recentUsers = userTurns.slice(-FULL_ATTACHMENT_TURNS)
  const recentUserIds = new Set(recentUsers.map((message) => message.id))
  const recentFrom = recentUsers.length ? branch.indexOf(recentUsers[0]!) : branch.length
  const input: ResponseInputItem[] = []
  let hasAttachments = false

  for (const [position, message] of branch.entries()) {
    const parts = message.content as MessagePart[]
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n")

    if (message.role === "assistant") {
      const content = [text, ...assistantNotes(parts)].filter(Boolean).join("\n\n")
      if (content) input.push({ role: "assistant", content })
      // Imagens geradas nos turnos recentes voltam como imagem: dá para pedir ajustes nelas.
      const images = parts.flatMap((part) =>
        part.type === "image" && filesById.has(part.fileId) ? [filesById.get(part.fileId)!] : [],
      )
      if (images.length && position > recentFrom) {
        input.push({
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "(Anexo automático do app, não é uma mensagem do usuário: as imagens que você gerou na resposta anterior, para referência.)",
            },
            ...(await Promise.all(
              images.map(async (file) => ({
                type: "input_image" as const,
                image_url: await r2().presignGet(file.r2Key),
                detail: "auto" as const,
              })),
            )),
          ],
        })
      }
      continue
    }
    if (message.role !== "user") continue

    const recent = recentUserIds.has(message.id)
    const content: ResponseInputItem.Message["content"] = []
    for (const part of parts) {
      if (part.type === "file") {
        const file = filesById.get(part.fileId)
        if (!file) continue
        hasAttachments = true
        const item = await fileToInput(file, recent)
        if (item) content.push(item)
      }
      if (part.type === "mention") {
        const sinapse = mentions.get(part.sinapseId)
        content.push({
          type: "input_text",
          text: !sinapse
            ? `[Sinapse mencionada: ${part.title} (não existe mais)]`
            : recent
              ? `Sinapse que o usuário mencionou (@${sinapse.title}, id ${part.sinapseId}):\n\n${truncate(sinapse.content, MAX_MENTION_CHARS)}`
              : `[Sinapse mencionada: ${sinapse.title}, id ${part.sinapseId}]`,
        })
      }
    }
    if (text) content.push({ type: "input_text", text })
    if (content.length) input.push({ type: "message", role: "user", content })
  }
  return { input, hasAttachments }
}

/**
 * Memória relevante para a última mensagem (RAG). Vai como mensagem de desenvolvedor logo
 * antes da última pergunta, para não quebrar o cache do prefixo (D41). Os arquivos buscados
 * são os da conversa, os do projeto e os citados no ramo (ex.: herdados de um fork).
 */
export async function retrieveContext(
  conversation: Conversation,
  query: string,
  extraFileIds: string[] = [],
) {
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
    .where(
      and(
        or(
          eq(files.conversationId, conversation.id),
          conversation.folderId ? eq(files.folderId, conversation.folderId) : undefined,
          extraFileIds.length ? inArray(files.id, extraFileIds) : undefined,
        ),
        isNull(files.deletedAt),
      ),
    )
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
      "Trechos de arquivos desta conversa ou do projeto:\n\n" +
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

/** Arquivos enviados pelo usuário que vão para o container do interpretador de código. */
export async function codeInterpreterFiles(conversation: Conversation, branch: Message[]) {
  const ids = branch.flatMap((message) =>
    message.role === "user"
      ? (message.content as MessagePart[]).flatMap((part) =>
          part.type === "file" ? [part.fileId] : [],
        )
      : [],
  )
  return db
    .select()
    .from(files)
    .where(
      and(
        isNull(files.deletedAt),
        eq(files.origin, "upload"),
        or(
          ids.length ? inArray(files.id, ids) : undefined,
          conversation.folderId ? eq(files.folderId, conversation.folderId) : undefined,
          // or() sem condições vira "sem filtro": garante que nada passe.
          sql`false`,
        ),
      ),
    )
}
