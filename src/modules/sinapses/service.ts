import { and, asc, cosineDistance, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm"
import { db } from "../../db/client.js"
import {
  sinapseChunks,
  sinapseLinks,
  sinapseSources,
  sinapseSuggestions,
  sinapseVersions,
  sinapses,
} from "../../db/schema.js"
import { chunkText } from "../../lib/chunk.js"
import { embed, embedOne } from "../../lib/embeddings.js"
import { HttpError, notFound } from "../../lib/http.js"
import { getInternal, internalKeys, setInternal } from "../settings/service.js"
import { orderedPair } from "./links.js"

export type Sinapse = typeof sinapses.$inferSelect
type Author = "ai" | "user"

export type SinapseInput = {
  title: string
  emoji?: string | null
  summary: string
  content: string
  tags?: string[]
}

export type WriteContext = {
  author: Author
  reason?: string | null
  sourceMessageId?: string | null
  conversationId?: string | null
  fileId?: string | null
}

const normalizeTags = (tags: string[] = []) =>
  [
    ...new Set(tags.map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean)),
  ].slice(0, 12)

// ─── Leitura ──────────────────────────────────────────────────────────────────

export async function getSinapse(id: string) {
  const [row] = await db
    .select()
    .from(sinapses)
    .where(and(eq(sinapses.id, id), isNull(sinapses.deletedAt)))
  if (!row) throw notFound("Sinapse")
  return row
}

/** Índice compacto (título + resumo) de todas as sinapses ativas, para o contexto do chat. */
export async function sinapseIndex(limit = 120) {
  return db
    .select({
      id: sinapses.id,
      title: sinapses.title,
      summary: sinapses.summary,
      pinned: sinapses.pinned,
    })
    .from(sinapses)
    .where(and(eq(sinapses.status, "active"), isNull(sinapses.deletedAt)))
    .orderBy(desc(sinapses.pinned), desc(sinapses.updatedAt))
    .limit(limit)
}

export async function pinnedSinapses() {
  return db
    .select()
    .from(sinapses)
    .where(
      and(eq(sinapses.pinned, true), eq(sinapses.status, "active"), isNull(sinapses.deletedAt)),
    )
    .orderBy(asc(sinapses.createdAt))
}

/** Busca semântica nos pedaços das sinapses ativas. */
export async function searchSinapseChunks(vector: number[], { limit = 6, minScore = 0.3 } = {}) {
  const distance = cosineDistance(sinapseChunks.embedding, vector)
  const rows = await db
    .select({
      sinapseId: sinapseChunks.sinapseId,
      title: sinapses.title,
      text: sinapseChunks.text,
      score: sql<number>`1 - (${distance})`,
    })
    .from(sinapseChunks)
    .innerJoin(sinapses, eq(sinapses.id, sinapseChunks.sinapseId))
    .where(and(eq(sinapses.status, "active"), isNull(sinapses.deletedAt)))
    .orderBy(distance)
    .limit(limit)
  return rows.filter((row) => row.score >= minScore)
}

/** Sinapses com resumo parecido (para evitar duplicatas e sugerir mesclas). */
export async function similarSinapses(
  vector: number[],
  { limit = 5, excludeId }: { limit?: number; excludeId?: string } = {},
) {
  const distance = cosineDistance(sinapses.summaryEmbedding, vector)
  return db
    .select({
      id: sinapses.id,
      title: sinapses.title,
      summary: sinapses.summary,
      locked: sinapses.locked,
      score: sql<number>`1 - (${distance})`,
    })
    .from(sinapses)
    .where(
      and(
        eq(sinapses.status, "active"),
        isNull(sinapses.deletedAt),
        sql`${sinapses.summaryEmbedding} is not null`,
        excludeId ? ne(sinapses.id, excludeId) : undefined,
      ),
    )
    .orderBy(distance)
    .limit(limit)
}

/** Busca textual + semântica, para a tool `search_sinapses` e a tela. */
export async function searchSinapses(query: string, limit = 8) {
  const { vector } = await embedOne(query)
  const semantic = await searchSinapseChunks(vector, { limit: limit * 2, minScore: 0.2 })
  const textual = await db
    .select({ id: sinapses.id, title: sinapses.title, summary: sinapses.summary })
    .from(sinapses)
    .where(
      and(
        isNull(sinapses.deletedAt),
        eq(sinapses.status, "active"),
        sql`${sinapses.searchVector} @@ websearch_to_tsquery('portuguese', ${query})`,
      ),
    )
    .limit(limit)

  const results = new Map<string, { id: string; title: string; snippet: string; score: number }>()
  for (const row of semantic) {
    if (!results.has(row.sinapseId)) {
      results.set(row.sinapseId, {
        id: row.sinapseId,
        title: row.title,
        snippet: row.text.slice(0, 400),
        score: row.score,
      })
    }
  }
  for (const row of textual) {
    const existing = results.get(row.id)
    if (existing) existing.score += 0.2
    else results.set(row.id, { id: row.id, title: row.title, snippet: row.summary, score: 0.5 })
  }
  return [...results.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

// ─── Escrita (sempre versionada, D20) ─────────────────────────────────────────

async function addVersion(sinapse: Sinapse, context: WriteContext) {
  const [version] = await db
    .insert(sinapseVersions)
    .values({
      sinapseId: sinapse.id,
      title: sinapse.title,
      emoji: sinapse.emoji,
      summary: sinapse.summary,
      content: sinapse.content,
      tags: sinapse.tags,
      author: context.author,
      reason: context.reason ?? null,
      sourceMessageId: context.sourceMessageId ?? null,
    })
    .returning({ id: sinapseVersions.id })
  if (context.conversationId || context.sourceMessageId || context.fileId) {
    await db.insert(sinapseSources).values({
      sinapseId: sinapse.id,
      conversationId: context.conversationId ?? null,
      messageId: context.sourceMessageId ?? null,
      fileId: context.fileId ?? null,
    })
  }
  return version!.id
}

/** Recalcula pedaços e embeddings de uma sinapse. */
export async function reindexSinapse(
  sinapse: Pick<Sinapse, "id" | "title" | "summary" | "content">,
) {
  const header = `# ${sinapse.title}\n\n${sinapse.summary}`
  const pieces = chunkText(sinapse.content)
  const texts = [header, ...pieces.map((piece) => `${sinapse.title}\n\n${piece}`)]
  const { model, vectors } = await embed(texts)
  await db.transaction(async (tx) => {
    await tx.delete(sinapseChunks).where(eq(sinapseChunks.sinapseId, sinapse.id))
    await tx.insert(sinapseChunks).values(
      texts.map((text, idx) => ({
        sinapseId: sinapse.id,
        idx,
        text,
        embeddingModel: model,
        embedding: vectors[idx]!,
      })),
    )
    await tx
      .update(sinapses)
      .set({
        summaryEmbedding: vectors[0]!,
        summaryEmbeddingModel: model,
        updatedAt: sql`${sinapses.updatedAt}`,
      })
      .where(eq(sinapses.id, sinapse.id))
  })
}

export async function createSinapse(input: SinapseInput, context: WriteContext) {
  const title = input.title.trim().slice(0, 120)
  const [row] = await db
    .insert(sinapses)
    .values({
      title,
      emoji: input.emoji ?? null,
      summary: input.summary.trim(),
      content: normalizeContent(title, input.content),
      tags: normalizeTags(input.tags),
      createdBy: context.author,
    })
    .returning()
  const versionId = await addVersion(row!, { ...context, reason: context.reason ?? "Criada" })
  await reindexSinapse(row!)
  return { sinapse: row!, versionId }
}

export async function updateSinapse(
  id: string,
  patch: Partial<SinapseInput> & {
    locked?: boolean
    pinned?: boolean
    status?: "active" | "archived"
  },
  context: WriteContext,
) {
  const current = await getSinapse(id)
  const title = patch.title !== undefined ? patch.title.trim().slice(0, 120) : current.title
  const [row] = await db
    .update(sinapses)
    .set({
      ...(patch.title !== undefined ? { title } : {}),
      ...(patch.emoji !== undefined ? { emoji: patch.emoji } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary.trim() } : {}),
      ...(patch.content !== undefined ? { content: normalizeContent(title, patch.content) } : {}),
      ...(patch.tags !== undefined ? { tags: normalizeTags(patch.tags) } : {}),
      ...(patch.locked !== undefined ? { locked: patch.locked } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    })
    .where(eq(sinapses.id, id))
    .returning()
  const changedText =
    row!.title !== current.title ||
    row!.summary !== current.summary ||
    row!.content !== current.content
  const changed =
    changedText || row!.emoji !== current.emoji || row!.tags.join() !== current.tags.join()
  const versionId = changed ? await addVersion(row!, context) : null
  if (changedText) await reindexSinapse(row!)
  return { sinapse: row!, versionId }
}

const headingText = (line: string) =>
  line
    .replace(/^#+\s*/, "")
    .trim()
    .toLowerCase()

/** Tira do início do markdown um título (de qualquer nível) igual a `title`. */
function stripLeadingHeading(markdown: string, title: string) {
  const text = markdown.trim()
  const firstLine = text.split("\n", 1)[0]!
  if (!/^#{1,6}\s/.test(firstLine) || headingText(firstLine) !== title.trim().toLowerCase()) {
    return text
  }
  return text.slice(firstLine.length).trim()
}

/**
 * Arruma o markdown antes de gravar: a página já mostra o título da sinapse, então um
 * "# Título" no topo sai; e títulos iguais em sequência, sem nada entre eles, viram um só.
 */
export function normalizeContent(title: string, content: string) {
  const lines = stripLeadingHeading(content, title).split("\n")
  const result: string[] = []
  let previous = ""
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && previous === line.trim()) continue
    result.push(line)
    if (line.trim()) previous = line.trim()
  }
  return result
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Aplica uma operação de seção sobre o markdown (usada pela IA). */
export function applySectionOperation(
  content: string,
  operation: "append_section" | "replace_section" | "replace_all",
  sectionTitle: string,
  rawBody: string,
) {
  if (operation === "replace_all") return rawBody.trim()
  const heading = sectionTitle.trim()
  // A IA costuma repetir o título da seção no começo do corpo.
  const body = heading ? stripLeadingHeading(rawBody, heading) : rawBody
  if (operation === "append_section" || !heading) {
    return `${content.trim()}\n\n${heading ? `## ${heading}\n\n` : ""}${body.trim()}`.trim()
  }
  // replace_section: troca do "## Título" até o próximo título de mesmo nível ou superior.
  const lines = content.split("\n")
  const start = lines.findIndex(
    (line) => /^#{1,3}\s/.test(line) && headingText(line) === heading.toLowerCase(),
  )
  if (start === -1) return `${content.trim()}\n\n## ${heading}\n\n${body.trim()}`.trim()
  const level = lines[start]!.match(/^#+/)![0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const match = lines[i]!.match(/^(#+)\s/)
    if (match && match[1]!.length <= level) {
      end = i
      break
    }
  }
  return [
    ...lines.slice(0, start),
    `${"#".repeat(level)} ${heading}`,
    "",
    body.trim(),
    "",
    ...lines.slice(end),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export async function softDeleteSinapse(id: string) {
  await getSinapse(id)
  await db.update(sinapses).set({ deletedAt: new Date() }).where(eq(sinapses.id, id))
}

// ─── Versões e desfazer ───────────────────────────────────────────────────────

export async function listVersions(sinapseId: string) {
  return db
    .select()
    .from(sinapseVersions)
    .where(eq(sinapseVersions.sinapseId, sinapseId))
    .orderBy(desc(sinapseVersions.createdAt))
}

/** Restaura o conteúdo de uma versão (gera uma versão nova, nada é perdido). */
export async function restoreVersion(
  sinapseId: string,
  versionId: string,
  author: Author = "user",
) {
  const [version] = await db
    .select()
    .from(sinapseVersions)
    .where(and(eq(sinapseVersions.id, versionId), eq(sinapseVersions.sinapseId, sinapseId)))
  if (!version) throw notFound("Versão")
  return updateSinapse(
    sinapseId,
    {
      title: version.title,
      emoji: version.emoji,
      summary: version.summary,
      content: version.content,
      tags: version.tags,
    },
    { author, reason: `Restaurada a versão de ${version.createdAt.toLocaleString("pt-BR")}` },
  )
}

/**
 * Desfaz a mudança que gerou `versionId` (chip "desfazer" no chat):
 * volta para a versão anterior; se era a criação, a sinapse vai para a lixeira.
 */
export async function undoVersion(versionId: string) {
  const [version] = await db.select().from(sinapseVersions).where(eq(sinapseVersions.id, versionId))
  if (!version) throw notFound("Versão")
  const [previous] = await db
    .select()
    .from(sinapseVersions)
    .where(
      and(
        eq(sinapseVersions.sinapseId, version.sinapseId),
        lt(sinapseVersions.createdAt, version.createdAt),
      ),
    )
    .orderBy(desc(sinapseVersions.createdAt))
    .limit(1)
  if (!previous) {
    await softDeleteSinapse(version.sinapseId)
    return { deleted: true as const, sinapseId: version.sinapseId }
  }
  await restoreVersion(version.sinapseId, previous.id)
  return { deleted: false as const, sinapseId: version.sinapseId }
}

// ─── Conexões ─────────────────────────────────────────────────────────────────

export async function linkSinapses(a: string, b: string, reason: string | null, author: Author) {
  const pair = orderedPair(a, b)
  await Promise.all([getSinapse(pair.sinapseA), getSinapse(pair.sinapseB)])
  await db
    .insert(sinapseLinks)
    .values({ ...pair, reason, createdBy: author })
    .onConflictDoUpdate({ target: [sinapseLinks.sinapseA, sinapseLinks.sinapseB], set: { reason } })
  return pair
}

export async function unlinkSinapses(a: string, b: string) {
  const pair = orderedPair(a, b)
  await db
    .delete(sinapseLinks)
    .where(and(eq(sinapseLinks.sinapseA, pair.sinapseA), eq(sinapseLinks.sinapseB, pair.sinapseB)))
}

export async function linksOf(id: string) {
  const rows = await db
    .select()
    .from(sinapseLinks)
    .where(or(eq(sinapseLinks.sinapseA, id), eq(sinapseLinks.sinapseB, id)))
  const otherIds = rows.map((row) => (row.sinapseA === id ? row.sinapseB : row.sinapseA))
  if (!otherIds.length) return []
  const others = await db
    .select({ id: sinapses.id, title: sinapses.title, emoji: sinapses.emoji })
    .from(sinapses)
    .where(and(inArray(sinapses.id, otherIds), isNull(sinapses.deletedAt)))
  const byId = new Map(others.map((other) => [other.id, other]))
  return rows
    .map((row) => {
      const other = byId.get(row.sinapseA === id ? row.sinapseB : row.sinapseA)
      return other ? { ...other, reason: row.reason, createdBy: row.createdBy } : null
    })
    .filter((row) => row !== null)
}

export async function graph() {
  const nodes = await db
    .select({
      id: sinapses.id,
      title: sinapses.title,
      emoji: sinapses.emoji,
      pinned: sinapses.pinned,
      tags: sinapses.tags,
      size: sql<number>`length(${sinapses.content})`,
    })
    .from(sinapses)
    .where(and(eq(sinapses.status, "active"), isNull(sinapses.deletedAt)))
  const ids = new Set(nodes.map((node) => node.id))
  const edges = (
    await db
      .select({
        source: sinapseLinks.sinapseA,
        target: sinapseLinks.sinapseB,
        reason: sinapseLinks.reason,
      })
      .from(sinapseLinks)
  ).filter((edge) => ids.has(edge.source) && ids.has(edge.target))
  return { nodes, edges }
}

// ─── Sugestões (sinapse travada ou conteúdo externo, D21/D37) ─────────────────

export type SuggestionPayload =
  | { kind: "create"; input: SinapseInput }
  | { kind: "update"; patch: Partial<SinapseInput> }
  | { kind: "merge"; sourceIds: string[] }
  | { kind: "link"; otherId: string }

export async function suggest(
  sinapseId: string | null,
  payload: SuggestionPayload,
  reason: string | null,
  sourceMessageId: string | null = null,
) {
  const [row] = await db
    .insert(sinapseSuggestions)
    .values({ sinapseId, kind: payload.kind, payload, reason, sourceMessageId })
    .returning({ id: sinapseSuggestions.id })
  return row!.id
}

export async function resolveSuggestion(id: string, accept: boolean) {
  const [suggestion] = await db
    .select()
    .from(sinapseSuggestions)
    .where(and(eq(sinapseSuggestions.id, id), eq(sinapseSuggestions.status, "pending")))
  if (!suggestion) throw notFound("Sugestão")

  let sinapseId = suggestion.sinapseId
  if (accept) {
    const payload = suggestion.payload as SuggestionPayload
    const context: WriteContext = {
      author: "ai",
      reason: `Sugestão aceita${suggestion.reason ? `: ${suggestion.reason}` : ""}`,
      sourceMessageId: suggestion.sourceMessageId,
    }
    if (payload.kind === "create")
      sinapseId = (await createSinapse(payload.input, context)).sinapse.id
    if (payload.kind === "update" && sinapseId)
      await updateSinapse(sinapseId, payload.patch, context)
    if (payload.kind === "link" && sinapseId)
      await linkSinapses(sinapseId, payload.otherId, suggestion.reason, "ai")
    if (payload.kind === "merge" && sinapseId)
      await mergeSinapses(sinapseId, payload.sourceIds, context)
  }
  await db
    .update(sinapseSuggestions)
    .set({ status: accept ? "accepted" : "rejected", resolvedAt: new Date(), sinapseId })
    .where(eq(sinapseSuggestions.id, id))
  return { sinapseId }
}

// ─── Mesclar e dividir ────────────────────────────────────────────────────────

/** Junta as fontes na alvo (seções concatenadas) e arquiva as fontes. */
export async function mergeSinapses(targetId: string, sourceIds: string[], context: WriteContext) {
  const ids = sourceIds.filter((sourceId) => sourceId !== targetId)
  if (!ids.length)
    throw new HttpError(400, "bad_request", "Escolha ao menos uma sinapse para mesclar.")
  const target = await getSinapse(targetId)
  const sources = await Promise.all(ids.map(getSinapse))

  const content = [
    target.content,
    ...sources.map(
      (source) =>
        `## ${source.emoji ? `${source.emoji} ` : ""}${source.title}\n\n${source.content}`,
    ),
  ].join("\n\n")
  const tags = [...target.tags, ...sources.flatMap((source) => source.tags)]

  const result = await updateSinapse(
    targetId,
    { content, tags },
    {
      ...context,
      reason: context.reason ?? `Mesclada com: ${sources.map((source) => source.title).join(", ")}`,
    },
  )

  for (const source of sources) {
    // As conexões e as origens das fontes passam para a alvo.
    for (const link of await linksOf(source.id)) {
      if (link.id !== targetId) await linkSinapses(targetId, link.id, link.reason, link.createdBy)
    }
    await db
      .update(sinapseSources)
      .set({ sinapseId: targetId })
      .where(eq(sinapseSources.sinapseId, source.id))
    await updateSinapse(
      source.id,
      { status: "archived" },
      { author: context.author, reason: `Mesclada em "${target.title}"` },
    )
  }
  return result
}

/** Move parte do conteúdo para uma sinapse nova e conecta as duas. */
export async function splitSinapse(
  id: string,
  remainingContent: string,
  extracted: SinapseInput,
  author: Author = "user",
) {
  const original = await getSinapse(id)
  const created = await createSinapse(extracted, {
    author,
    reason: `Dividida de "${original.title}"`,
  })
  await updateSinapse(
    id,
    { content: remainingContent },
    { author, reason: `Parte movida para "${extracted.title}"` },
  )
  await linkSinapses(id, created.sinapse.id, "Divisão", author)
  return created
}

// ─── "Sobre mim" ──────────────────────────────────────────────────────────────

/** Garante a sinapse especial "Sobre mim", fixada no contexto (seção 4.1). */
export async function ensureAboutMe() {
  const existingId = await getInternal<string>(internalKeys.aboutMeSinapseId)
  if (existingId) {
    const [row] = await db
      .select({ id: sinapses.id })
      .from(sinapses)
      .where(and(eq(sinapses.id, existingId), isNull(sinapses.deletedAt)))
    if (row) return row.id
  }
  const { sinapse } = await createSinapse(
    {
      title: "Sobre mim",
      emoji: "🙂",
      summary: "Fatos centrais sobre mim e como prefiro as respostas.",
      content:
        "## Quem sou\n\n(ainda vazio)\n\n## Preferências de resposta\n\n- Responder em pt-BR.",
      tags: ["sobre-mim"],
    },
    { author: "ai", reason: "Criada automaticamente no primeiro uso" },
  )
  await db.update(sinapses).set({ pinned: true }).where(eq(sinapses.id, sinapse.id))
  await setInternal(internalKeys.aboutMeSinapseId, sinapse.id)
  return sinapse.id
}
