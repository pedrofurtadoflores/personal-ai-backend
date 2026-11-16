import { and, between, eq, isNull, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { diaryDays, diaryEntries, diaryTurns } from "../../db/schema.js"
import { HttpError, withErrors } from "../../lib/http.js"
import { enqueue } from "../../lib/jobs.js"
import { isoDate, jsonDates } from "../../lib/serialize.js"
import { diaryToday, monthRange } from "./dates.js"
import "./memory.js"
import {
  askNextQuestion,
  checkDate,
  condenseDay,
  diaryOpening,
  embedDay,
  ensureDay,
  entriesOf,
  entryKind,
  entryWithTurns,
  getDay,
  getEntry,
} from "./service.js"

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const mood = z.number().int().min(1).max(5)

const turnSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: isoDate,
})

const entrySchema = z.object({
  id: z.string(),
  date: z.string(),
  kind: z.enum(["live", "retro"]),
  status: z.enum(["open", "concluded"]),
  createdAt: isoDate,
  concludedAt: isoDate.nullable(),
  turns: z.array(turnSchema),
})

const daySchema = z.object({
  date: z.string(),
  mood: z.number().nullable(),
  summary: z.string(),
  learnings: z.array(z.string()),
  summaryEdited: z.boolean(),
  condensedAt: isoDate.nullable(),
})

const dayViewSchema = z.object({
  /** Pergunta de abertura: "Como está sendo seu dia?" (hoje) ou "Como foi seu dia?". */
  opening: z.string(),
  day: daySchema,
  entries: z.array(entrySchema),
})

const summarySchema = z.object({
  date: z.string(),
  mood: z.number().nullable(),
  summary: z.string(),
  learnings: z.array(z.string()),
  entryCount: z.number(),
  openCount: z.number(),
})

const toEntry = (entry: Awaited<ReturnType<typeof entryWithTurns>>) =>
  entrySchema.parse(jsonDates(entry))

async function dayView(forDate: string) {
  const [row, entries] = await Promise.all([getDay(forDate), entriesOf(forDate)])
  return dayViewSchema.parse(
    jsonDates({
      opening: diaryOpening[entryKind(forDate)],
      day: {
        date: forDate,
        mood: row?.mood ?? null,
        summary: row?.summary ?? "",
        learnings: row?.learnings ?? [],
        summaryEdited: row?.summaryEdited ?? false,
        condensedAt: row?.condensedAt ?? null,
      },
      entries,
    }),
  )
}

export const diaryRoutes: FastifyPluginAsyncZod = async (app) => {
  const rateLimit = { max: 40, timeWindow: "1 minute" }

  app.get(
    "/diary/days",
    {
      schema: {
        tags: ["diary"],
        summary: "Dias com registro em um mês (calendário e linha do tempo)",
        querystring: z.object({
          month: z
            .string()
            .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
            .optional(),
        }),
        response: withErrors({
          200: z.object({ today: z.string(), month: z.string(), days: z.array(summarySchema) }),
        }),
      },
    },
    async (request) => {
      const today = diaryToday()
      const month = request.query.month ?? today.slice(0, 7)
      const { from, to } = monthRange(month)
      const [days, counts] = await Promise.all([
        db
          .select()
          .from(diaryDays)
          .where(between(diaryDays.date, from, to)),
        db
          .select({
            date: diaryEntries.date,
            total: sql<number>`count(*)::int`,
            open: sql<number>`count(*) filter (where ${diaryEntries.status} = 'open')::int`,
          })
          .from(diaryEntries)
          .where(and(between(diaryEntries.date, from, to), isNull(diaryEntries.deletedAt)))
          .groupBy(diaryEntries.date),
      ])
      const byDate = new Map(counts.map((row) => [row.date, row]))
      return {
        today,
        month,
        days: days
          .map((day) => ({
            date: day.date,
            mood: day.mood,
            summary: day.summary,
            learnings: day.learnings,
            entryCount: byDate.get(day.date)?.total ?? 0,
            openCount: byDate.get(day.date)?.open ?? 0,
          }))
          .filter((day) => day.entryCount > 0 || day.mood !== null)
          .sort((a, b) => b.date.localeCompare(a.date)),
      }
    },
  )

  app.get(
    "/diary/days/:date",
    {
      schema: {
        tags: ["diary"],
        summary: "Um dia: condensado, humor e todas as entradas com as perguntas",
        params: z.object({ date }),
        response: withErrors({ 200: dayViewSchema }),
      },
    },
    async (request) => {
      checkDate(request.params.date)
      return dayView(request.params.date)
    },
  )

  app.patch(
    "/diary/days/:date",
    {
      schema: {
        tags: ["diary"],
        summary: "Marcar o humor ou editar o texto condensado e os aprendizados",
        params: z.object({ date }),
        body: z
          .object({
            mood: mood.nullable(),
            summary: z.string().max(30_000),
            learnings: z.array(z.string().trim().min(1).max(500)).max(30),
          })
          .partial(),
        response: withErrors({ 200: dayViewSchema }),
      },
    },
    async (request) => {
      checkDate(request.params.date)
      const current = await ensureDay(request.params.date)
      const { mood: newMood, summary, learnings } = request.body
      const edited =
        (summary !== undefined && summary.trim() !== current.summary.trim()) ||
        (learnings !== undefined && learnings.join("\n") !== current.learnings.join("\n"))
      await db
        .update(diaryDays)
        .set({
          ...(newMood !== undefined ? { mood: newMood } : {}),
          ...(summary !== undefined ? { summary: summary.trim() } : {}),
          ...(learnings !== undefined ? { learnings } : {}),
          ...(edited ? { summaryEdited: true } : {}),
        })
        .where(eq(diaryDays.id, current.id))
      if (edited) await embedDay(request.params.date)
      return dayView(request.params.date)
    },
  )

  app.post(
    "/diary/days/:date/entries",
    {
      config: { rateLimit },
      schema: {
        tags: ["diary"],
        summary: "Nova entrada: o relato inicial; a IA responde com a primeira pergunta",
        description:
          "Vale para hoje e para qualquer dia passado. Se a pergunta não puder ser gerada, " +
          "a entrada é criada sem ela e `POST /diary/entries/:id/turns` com `skip` tenta de novo.",
        params: z.object({ date }),
        body: z.object({ text: z.string().trim().min(1).max(30_000) }),
        response: withErrors({ 201: entrySchema }),
      },
    },
    async (request, reply) => {
      const forDate = request.params.date
      checkDate(forDate)
      await ensureDay(forDate)
      const [created] = await db
        .insert(diaryEntries)
        .values({ date: forDate, kind: entryKind(forDate) })
        .returning()
      await db
        .insert(diaryTurns)
        .values({ entryId: created!.id, role: "user", text: request.body.text })
      await askAndSave(created!.id, request.log)
      return reply.code(201).send(toEntry(await entryWithTurns(created!.id)))
    },
  )

  app.post(
    "/diary/entries/:id/turns",
    {
      config: { rateLimit },
      schema: {
        tags: ["diary"],
        summary: "Responder à pergunta (ou pular) e receber a próxima",
        description: "A IA segue perguntando até a entrada ser concluída.",
        params: z.object({ id: z.uuid() }),
        body: z.object({
          text: z.string().trim().min(1).max(30_000).optional(),
          /** Sem resposta: a IA faz outra pergunta, de outro ângulo. */
          skip: z.boolean().optional(),
        }),
        response: withErrors({ 200: entrySchema }),
      },
    },
    async (request) => {
      const entry = await getEntry(request.params.id)
      if (entry.status !== "open") {
        throw new HttpError(409, "entry_closed", "Esta entrada já foi concluída.")
      }
      const { text, skip } = request.body
      if (!text && !skip) throw new HttpError(400, "bad_request", "Escreva uma resposta ou pule.")
      if (text) {
        await db.insert(diaryTurns).values({ entryId: entry.id, role: "user", text })
      }
      await askAndSave(entry.id, request.log, { skipped: !text })
      return toEntry(await entryWithTurns(entry.id))
    },
  )

  app.post(
    "/diary/entries/:id/conclude",
    {
      config: { rateLimit },
      schema: {
        tags: ["diary"],
        summary: "Concluir a entrada: condensa o dia de novo e guarda na memória (sinapses)",
        params: z.object({ id: z.uuid() }),
        body: z.object({ mood: mood.nullable().optional() }).default({}),
        response: withErrors({ 200: dayViewSchema }),
      },
    },
    async (request) => {
      const entry = await getEntry(request.params.id)
      if (entry.status !== "open") {
        throw new HttpError(409, "entry_closed", "Esta entrada já foi concluída.")
      }
      await db
        .update(diaryEntries)
        .set({ status: "concluded", concludedAt: new Date() })
        .where(eq(diaryEntries.id, entry.id))
      if (request.body.mood !== undefined) {
        const day = await ensureDay(entry.date)
        await db.update(diaryDays).set({ mood: request.body.mood }).where(eq(diaryDays.id, day.id))
      }
      await condenseDay(entry.date)
      await enqueue("diary.memorize", { entryId: entry.id })
      return dayView(entry.date)
    },
  )

  app.delete(
    "/diary/entries/:id",
    {
      config: { rateLimit },
      schema: {
        tags: ["diary"],
        summary: "Apagar uma entrada (some do dia, que é condensado de novo)",
        params: z.object({ id: z.uuid() }),
        response: withErrors({ 200: dayViewSchema }),
      },
    },
    async (request) => {
      const entry = await getEntry(request.params.id)
      await db
        .update(diaryEntries)
        .set({ deletedAt: new Date() })
        .where(eq(diaryEntries.id, entry.id))
      // Se o dia já tinha condensado (ou fica sem entradas), o texto acompanha.
      if (entry.status === "concluded") await condenseDay(entry.date)
      return dayView(entry.date)
    },
  )
}

/** Gera a próxima pergunta e a grava. Se a IA falhar, a entrada continua válida (dá para tentar de novo). */
async function askAndSave(
  entryId: string,
  log: { error: (error: unknown, message: string) => void },
  options: { skipped?: boolean } = {},
) {
  try {
    const question = await askNextQuestion(await entryWithTurns(entryId), options)
    await db.insert(diaryTurns).values({ entryId, role: "assistant", text: question })
  } catch (error) {
    log.error(error, "Não foi possível gerar a pergunta do diário")
  }
}
