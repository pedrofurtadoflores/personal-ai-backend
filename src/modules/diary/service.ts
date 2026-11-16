import { and, asc, cosineDistance, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm"
import { zodTextFormat } from "openai/helpers/zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { diaryDays, diaryEntries, diaryTurns } from "../../db/schema.js"
import { truncate } from "../../lib/chunk.js"
import { embedOne } from "../../lib/embeddings.js"
import { HttpError, notFound } from "../../lib/http.js"
import { openai } from "../../lib/openai.js"
import { fromResponsesUsage, recordUsage } from "../../lib/pricing.js"
import { getSettings } from "../settings/service.js"
import { diaryToday, isRealDate, longDate } from "./dates.js"

/**
 * Diário (D81). Cada entrada é uma sessão (relato + perguntas e respostas); ao concluir,
 * o dia inteiro é condensado de novo. O humor é sempre marcado pelo usuário, nunca inferido.
 * Tudo usa o modelo de background (barato).
 */

export type DiaryEntry = typeof diaryEntries.$inferSelect
export type DiaryTurn = typeof diaryTurns.$inferSelect
export type DiaryDay = typeof diaryDays.$inferSelect

export const diaryOpening = {
  live: "Como está sendo seu dia?",
  retro: "Como foi seu dia?",
} as const

const MAX_CONTEXT_DAYS = 5
const MAX_ENTRY_CHARS = 12_000

export const entryKind = (date: string) => (date === diaryToday() ? "live" : "retro")

/** Datas válidas: reais, não futuras (o dia atual vale) e não absurdamente antigas. */
export function checkDate(date: string) {
  if (!isRealDate(date) || date < "2000-01-01") {
    throw new HttpError(400, "bad_request", "Data inválida.")
  }
  if (date > diaryToday()) {
    throw new HttpError(
      400,
      "future_date",
      "Não dá para escrever sobre um dia que ainda não chegou.",
    )
  }
}

export async function getDay(date: string) {
  const [row] = await db.select().from(diaryDays).where(eq(diaryDays.date, date))
  return row ?? null
}

export async function ensureDay(date: string) {
  await db.insert(diaryDays).values({ date }).onConflictDoNothing()
  return (await getDay(date))!
}

export async function entriesOf(date: string) {
  const entries = await db
    .select()
    .from(diaryEntries)
    .where(and(eq(diaryEntries.date, date), isNull(diaryEntries.deletedAt)))
    .orderBy(asc(diaryEntries.createdAt))
  const turns = entries.length
    ? await db
        .select()
        .from(diaryTurns)
        .where(
          inArray(
            diaryTurns.entryId,
            entries.map((entry) => entry.id),
          ),
        )
        .orderBy(asc(diaryTurns.createdAt))
    : []
  return entries.map((entry) => ({
    ...entry,
    turns: turns.filter((turn) => turn.entryId === entry.id),
  }))
}
export type EntryWithTurns = Awaited<ReturnType<typeof entriesOf>>[number]

export async function getEntry(id: string) {
  const [entry] = await db
    .select()
    .from(diaryEntries)
    .where(and(eq(diaryEntries.id, id), isNull(diaryEntries.deletedAt)))
  if (!entry) throw notFound("Entrada")
  return entry
}

export async function entryWithTurns(id: string) {
  const entry = await getEntry(id)
  const found = (await entriesOf(entry.date)).find((item) => item.id === id)
  return found!
}

/** Quem falou, em ordem: serve de contexto para as perguntas e para o condensado. */
export const transcriptOf = (entry: EntryWithTurns) =>
  [
    `Pergunta de abertura: ${diaryOpening[entry.kind]}`,
    ...entry.turns.map((turn) => `${turn.role === "user" ? "Usuário" : "Você"}: ${turn.text}`),
  ].join("\n")

// ─── Perguntas ──────────────────────────────────────────────────────────────

const questionGuide = [
  "Você é o companheiro de um diário pessoal. O usuário escreve sobre o dia dele e você o ajuda a refletir com perguntas.",
  "Faça UMA pergunta por vez, curta, em pt-BR, baseada no que ele acabou de escrever. Sem listas, sem introdução, sem resumir o que ele disse.",
  "Varie o ângulo ao longo da conversa: como ele se sentiu, o que aprendeu, o que o surpreendeu, o que faria diferente, pelo que é grato, o que ficou em aberto, o que quer levar para amanhã. Aprofunde o que ele disse antes de mudar de assunto.",
  "Nunca repita uma pergunta já feita. Não dê conselhos, diagnósticos nem julgamentos, a menos que ele peça; se pedir algo, responda em uma ou duas frases e então pergunte.",
  "Tom caloroso e curioso, como um amigo atento. Sem emojis. Responda só com a pergunta.",
].join("\n")

/** Contexto dos dias anteriores: deixa a pergunta ligar o hoje ao que ele já contou. */
async function recentContext(date: string) {
  const rows = await db
    .select({ date: diaryDays.date, summary: diaryDays.summary })
    .from(diaryDays)
    .where(and(lt(diaryDays.date, date), sql`${diaryDays.summary} <> ''`))
    .orderBy(desc(diaryDays.date))
    .limit(MAX_CONTEXT_DAYS)
  return rows.reverse().map((row) => `- ${row.date}: ${truncate(row.summary, 700)}`)
}

export async function askNextQuestion(entry: EntryWithTurns, { skipped = false } = {}) {
  const settings = await getSettings()
  const [recent, sameDay] = await Promise.all([recentContext(entry.date), entriesOf(entry.date)])
  const others = sameDay.filter((other) => other.id !== entry.id && other.status === "concluded")
  const input = [
    `## O dia\n${longDate(entry.date)} (${
      entry.kind === "live"
        ? "escrito no próprio dia"
        : "o usuário escreve depois, em retrospectiva"
    })`,
    recent.length ? `## Dias recentes (resumos)\n${recent.join("\n")}` : "",
    others.length
      ? `## Outras entradas deste mesmo dia\n${others.map((other) => truncate(transcriptOf(other), 2_500)).join("\n\n")}`
      : "",
    `## Esta conversa\n${truncate(transcriptOf(entry), MAX_ENTRY_CHARS)}`,
    skipped
      ? "O usuário pulou a última pergunta: faça outra, de outro ângulo."
      : "Faça a próxima pergunta.",
  ]
    .filter(Boolean)
    .join("\n\n")

  const response = await openai().responses.create({
    model: settings.backgroundModel,
    store: false,
    instructions: questionGuide,
    input,
  })
  await recordUsage({
    source: "background",
    model: settings.backgroundModel,
    usage: fromResponsesUsage(response.usage),
  })
  const question = response.output_text.trim().replace(/^["«]|["»]$/g, "")
  return question || "Como você se sentiu com isso?"
}

// ─── Condensação ────────────────────────────────────────────────────────────

const condensedSchema = z.object({
  summary: z.string(),
  learnings: z.array(z.string()),
})

/** Embedding do condensado (busca e consulta pelo chat). Falha aqui não derruba o fluxo. */
export async function embedDay(date: string) {
  const day = await getDay(date)
  if (!day) return
  if (!day.summary.trim()) {
    await db
      .update(diaryDays)
      .set({ embedding: null, embeddingModel: null })
      .where(eq(diaryDays.id, day.id))
    return
  }
  try {
    const text = [day.summary, ...day.learnings.map((item) => `- ${item}`)].join("\n")
    const { model, vector } = await embedOne(`${day.date}\n\n${text}`)
    await db
      .update(diaryDays)
      .set({ embedding: vector, embeddingModel: model })
      .where(eq(diaryDays.id, day.id))
  } catch {
    // o reindex geral recalcula depois
  }
}

/**
 * Refaz o texto do dia a partir de todas as entradas concluídas. Se o usuário editou o
 * condensado, a IA parte do texto dele e incorpora o que é novo.
 */
export async function condenseDay(date: string) {
  const day = await ensureDay(date)
  const entries = (await entriesOf(date)).filter((entry) => entry.status === "concluded")

  if (!entries.length) {
    await db
      .update(diaryDays)
      .set({ summary: "", learnings: [], summaryEdited: false, condensedAt: null })
      .where(eq(diaryDays.id, day.id))
    await embedDay(date)
    return
  }

  const keepEdited = day.summaryEdited && day.summary.trim().length > 0
  const settings = await getSettings()
  const response = await openai().responses.parse({
    model: settings.backgroundModel,
    store: false,
    instructions: [
      "Você condensa o diário pessoal do usuário. Recebe as entradas de um dia (relatos dele e as perguntas que o ajudaram a refletir) e escreve o registro final do dia.",
      "Escreva em pt-BR, em primeira pessoa, na voz do usuário, como uma página de diário: fluida, sem tópicos, sem título. Use só o que ele disse: não invente fatos, sentimentos nem conclusões.",
      "Inclua o que aconteceu, como ele se sentiu e o que refletiu. Mantenha o tamanho proporcional ao que ele escreveu (de um parágrafo a poucos parágrafos).",
      "`learnings`: o que ele aprendeu ou percebeu no dia, em frases curtas na primeira pessoa. Lista vazia se não houve nada disso.",
      "Não infira nem mencione nota de humor.",
      keepEdited
        ? "O usuário editou o texto atual do dia: preserve o que ele escreveu e incorpore o que as entradas trazem de novo."
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    input: [
      `## ${longDate(date)}`,
      keepEdited ? `## Texto atual do dia (editado pelo usuário)\n${day.summary}` : "",
      ...entries.map(
        (entry, index) =>
          `## Entrada ${index + 1}\n${truncate(transcriptOf(entry), MAX_ENTRY_CHARS)}`,
      ),
    ]
      .filter(Boolean)
      .join("\n\n"),
    text: { format: zodTextFormat(condensedSchema, "diary_day") },
  })
  await recordUsage({
    source: "background",
    model: settings.backgroundModel,
    usage: fromResponsesUsage(response.usage),
  })

  // Sem resposta útil do modelo, o dia nunca fica sem texto: cai nos relatos do usuário.
  const parsed = response.output_parsed
  const fallback = entries
    .flatMap((entry) => entry.turns.filter((turn) => turn.role === "user").map((turn) => turn.text))
    .join("\n\n")
  await db
    .update(diaryDays)
    .set({
      summary: parsed?.summary.trim() || fallback,
      learnings: (parsed?.learnings ?? []).map((item) => item.trim()).filter(Boolean),
      summaryEdited: false,
      condensedAt: new Date(),
    })
    .where(eq(diaryDays.id, day.id))
  await embedDay(date)
}

// ─── Consulta (chat) ────────────────────────────────────────────────────────

/** Busca semântica nos dias condensados, para a tool `search_diary` do chat. */
export async function searchDiary(query: string, limit = 5) {
  const { vector } = await embedOne(query)
  const distance = cosineDistance(diaryDays.embedding, vector)
  const rows = await db
    .select({
      date: diaryDays.date,
      summary: diaryDays.summary,
      mood: diaryDays.mood,
      score: sql<number>`1 - (${distance})`,
    })
    .from(diaryDays)
    .where(sql`${diaryDays.embedding} is not null`)
    .orderBy(distance)
    .limit(limit)
  return rows
    .filter((row) => row.score >= 0.2)
    .map((row) => ({ date: row.date, mood: row.mood, excerpt: truncate(row.summary, 600) }))
}

export async function readDiaryDay(date: string) {
  if (!isRealDate(date)) throw new HttpError(400, "bad_request", "Data inválida.")
  const day = await getDay(date)
  if (!day || !day.summary.trim()) return null
  return { date: day.date, mood: day.mood, summary: day.summary, learnings: day.learnings }
}
