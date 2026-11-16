import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { buildApp } from "../src/app.js"
import { db } from "../src/db/client.js"
import { diaryEntries, sinapses } from "../src/db/schema.js"
import { enqueuedJobs, runJobNow } from "../src/lib/jobs.js"
import { setOpenAIClient } from "../src/lib/openai.js"
import { diaryToday } from "../src/modules/diary/dates.js"
import { searchDiary } from "../src/modules/diary/service.js"
import { FakeOpenAI, functionCallRound, parseSse, resetData, textRound } from "./fakes.js"
import { bearer, loginToken } from "./helpers.js"

const app = await buildApp()
const fake = new FakeOpenAI()
let auth: Record<string, string>

beforeAll(async () => {
  await app.ready()
  setOpenAIClient(fake.asClient())
  auth = bearer(await loginToken(app))
})
afterAll(async () => {
  setOpenAIClient(undefined)
  await app.close()
})
beforeEach(async () => {
  await resetData()
  fake.rounds = []
  fake.parsed = []
  fake.texts = []
  fake.requests = []
  enqueuedJobs.length = 0
})

type Turn = { id: string; role: "user" | "assistant"; text: string }
type Entry = { id: string; date: string; kind: string; status: string; turns: Turn[] }
type DayView = {
  opening: string
  day: { mood: number | null; summary: string; learnings: string[]; summaryEdited: boolean }
  entries: Entry[]
}

const PAST = "2026-01-10"
const NEXT_PAST = "2026-01-11"

async function call(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) {
  return app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) })
}

async function startEntry(date: string, text: string, question = "Como você se sentiu?") {
  fake.texts.push(question)
  const response = await call("POST", `/diary/days/${date}/entries`, { text })
  expect(response.statusCode).toBe(201)
  return response.json<Entry>()
}

async function conclude(entry: Entry, summary: string, learnings: string[] = [], body = {}) {
  fake.parsed.push({ summary, learnings })
  const response = await call("POST", `/diary/entries/${entry.id}/conclude`, body)
  expect(response.statusCode).toBe(200)
  return response.json<DayView>()
}

/** Instruções e entrada da última chamada à OpenAI (sem streaming). */
const lastRequest = () => fake.requests.at(-1) as unknown as { instructions: string; input: string }

describe("diário (D81)", () => {
  it("o dia vira às 4h: 3h59 ainda é o dia anterior", () => {
    // 2026-11-16 06:59 UTC = 03:59 em São Paulo; 07:00 UTC = 04:00.
    expect(diaryToday(new Date("2026-11-16T06:59:00Z"))).toBe("2026-11-15")
    expect(diaryToday(new Date("2026-11-16T07:00:00Z"))).toBe("2026-11-16")
  })

  it("recusa data inexistente e dia que ainda não chegou", async () => {
    const invalid = await call("GET", "/diary/days/2026-02-31")
    expect(invalid.statusCode).toBe(400)
    const future = await call("POST", "/diary/days/2999-01-01/entries", { text: "oi" })
    expect(future.statusCode).toBe(400)
    expect(future.json().error).toBe("future_date")
  })

  it("escreve, a IA pergunta sem limite, dá para pular e concluir condensa o dia", async () => {
    const today = diaryToday()
    const entry = await startEntry(today, "Hoje o trabalho foi corrido.", "O que mais pesou?")
    expect(entry).toMatchObject({ kind: "live", status: "open" })
    expect(entry.turns.map((turn) => turn.role)).toEqual(["user", "assistant"])
    expect(lastRequest().input).toContain("Hoje o trabalho foi corrido.")
    expect(lastRequest().input).toContain("Como está sendo seu dia?")

    // Mais de três perguntas: segue até o usuário concluir.
    let current = entry
    for (let round = 1; round <= 4; round += 1) {
      fake.texts.push(`Pergunta ${round + 1}?`)
      const response = await call("POST", `/diary/entries/${entry.id}/turns`, {
        text: `Resposta ${round}`,
      })
      expect(response.statusCode).toBe(200)
      current = response.json<Entry>()
    }
    expect(current.turns).toHaveLength(10)

    // Pular: não grava resposta e pede outro ângulo.
    fake.texts.push("E o que você aprendeu?")
    const skipped = (
      await call("POST", `/diary/entries/${entry.id}/turns`, { skip: true })
    ).json<Entry>()
    expect(skipped.turns).toHaveLength(11)
    expect(skipped.turns.at(-1)).toMatchObject({
      role: "assistant",
      text: "E o que você aprendeu?",
    })
    expect(lastRequest().input).toContain("pulou a última pergunta")

    const empty = await call("POST", `/diary/entries/${entry.id}/turns`, {})
    expect(empty.statusCode).toBe(400)

    const view = await conclude(
      entry,
      "Foi um dia corrido, mas aprendi a pedir ajuda.",
      ["Pedir ajuda cedo evita retrabalho."],
      { mood: 4 },
    )
    expect(view.day).toMatchObject({
      summary: "Foi um dia corrido, mas aprendi a pedir ajuda.",
      learnings: ["Pedir ajuda cedo evita retrabalho."],
      mood: 4,
    })
    expect(view.entries[0]).toMatchObject({ status: "concluded" })
    expect(enqueuedJobs.some((job) => job.name === "diary.memorize")).toBe(true)

    // Entrada concluída não aceita mais respostas nem outra conclusão.
    expect((await call("POST", `/diary/entries/${entry.id}/turns`, { text: "x" })).statusCode).toBe(
      409,
    )
    expect((await call("POST", `/diary/entries/${entry.id}/conclude`, {})).statusCode).toBe(409)
  })

  it("o humor é só do usuário: sem marcar, fica vazio, e o condensado não o infere", async () => {
    const entry = await startEntry(PAST, "Dia tranquilo.")
    const view = await conclude(entry, "Um dia tranquilo.")
    expect(view.day.mood).toBeNull()
    const condenseRequest = fake.requests.at(-1) as unknown as { instructions: string }
    expect(condenseRequest.instructions).toContain("Não infira nem mencione nota de humor")

    const marked = await call("PATCH", `/diary/days/${PAST}`, { mood: 5 })
    expect(marked.json<DayView>().day.mood).toBe(5)
    const cleared = await call("PATCH", `/diary/days/${PAST}`, { mood: null })
    expect(cleared.json<DayView>().day.mood).toBeNull()
    expect((await call("PATCH", `/diary/days/${PAST}`, { mood: 9 })).statusCode).toBe(400)
  })

  it("dá para escrever sobre dias passados e adicionar outra entrada: condensa tudo de novo", async () => {
    const first = await startEntry(PAST, "De manhã fui ao médico.")
    expect(first.kind).toBe("retro")
    await conclude(first, "Fui ao médico de manhã.")

    // Dias depois, volta ao mesmo dia e acrescenta.
    const second = await startEntry(PAST, "Esqueci de contar: à noite jantei com a Ana.")
    expect(lastRequest().input).toContain("Outras entradas deste mesmo dia")
    expect(lastRequest().input).toContain("De manhã fui ao médico.")

    const view = await conclude(second, "Fui ao médico de manhã e jantei com a Ana à noite.")
    expect(view.opening).toBe("Como foi seu dia?")
    expect(view.entries).toHaveLength(2)
    expect(view.day.summary).toContain("jantei com a Ana")
    const condenseInput = (fake.requests.at(-1) as unknown as { input: string }).input
    expect(condenseInput).toContain("## Entrada 1")
    expect(condenseInput).toContain("## Entrada 2")
    expect(condenseInput).toContain("jantei com a Ana")
  })

  it("o texto editado vira ponto de partida do próximo condensado", async () => {
    const first = await startEntry(PAST, "Fui à praia.")
    await conclude(first, "Fui à praia.")

    const edited = await call("PATCH", `/diary/days/${PAST}`, {
      summary: "Fui à praia com meu irmão.",
      learnings: ["Preciso passar mais tempo com ele."],
    })
    expect(edited.json<DayView>().day).toMatchObject({
      summary: "Fui à praia com meu irmão.",
      summaryEdited: true,
    })

    const second = await startEntry(PAST, "Depois tomei um açaí.")
    const view = await conclude(second, "Fui à praia com meu irmão e tomei um açaí.")
    const input = fake.requests.at(-1) as unknown as { input: string; instructions: string }
    expect(input.input).toContain("Texto atual do dia (editado pelo usuário)")
    expect(input.input).toContain("Fui à praia com meu irmão.")
    expect(input.instructions).toContain("preserve o que ele escreveu")
    expect(view.day.summaryEdited).toBe(false)
  })

  it("as perguntas usam o contexto dos dias anteriores", async () => {
    const yesterday = await startEntry(PAST, "Estou ansioso com a entrevista de emprego.")
    await conclude(yesterday, "Estava ansioso com a entrevista de emprego.")

    await startEntry(NEXT_PAST, "A entrevista foi hoje.")
    expect(lastRequest().input).toContain("Dias recentes")
    expect(lastRequest().input).toContain("ansioso com a entrevista de emprego")
  })

  it("apagar entrada condensa de novo; sem entradas concluídas, o texto some", async () => {
    const first = await startEntry(PAST, "Primeira.")
    await conclude(first, "Texto sobre a primeira.")
    const second = await startEntry(PAST, "Segunda.")
    await conclude(second, "Texto sobre as duas.")

    fake.parsed.push({ summary: "Texto só da segunda.", learnings: [] })
    const afterFirst = await call("DELETE", `/diary/entries/${first.id}`)
    expect(afterFirst.json<DayView>().entries).toHaveLength(1)
    expect(afterFirst.json<DayView>().day.summary).toBe("Texto só da segunda.")

    const afterLast = await call("DELETE", `/diary/entries/${second.id}`)
    expect(afterLast.json<DayView>().entries).toHaveLength(0)
    expect(afterLast.json<DayView>().day.summary).toBe("")
    // Nada é apagado de verdade (D27).
    const rows = await db.select().from(diaryEntries).where(eq(diaryEntries.date, PAST))
    expect(rows).toHaveLength(2)
  })

  it("calendário do mês lista só dias com registro, do mais novo ao mais antigo", async () => {
    const a = await startEntry(PAST, "Um.")
    await conclude(a, "Dia um.", [], { mood: 3 })
    await startEntry(NEXT_PAST, "Dois, ainda aberta.")

    const month = (await call("GET", "/diary/days?month=2026-01")).json<{
      today: string
      days: { date: string; mood: number | null; entryCount: number; openCount: number }[]
    }>()
    expect(month.today).toBe(diaryToday())
    expect(month.days.map((day) => day.date)).toEqual([NEXT_PAST, PAST])
    expect(month.days[0]).toMatchObject({ entryCount: 1, openCount: 1 })
    expect(month.days[1]).toMatchObject({ mood: 3, entryCount: 1, openCount: 0 })
    expect((await call("GET", "/diary/days?month=2026-13")).statusCode).toBe(400)
  })

  it("se a IA falhar ao perguntar, a entrada fica salva e dá para tentar de novo", async () => {
    const original = fake.responses.create
    fake.responses.create = async () => {
      throw new Error("indisponível")
    }
    const response = await call("POST", `/diary/days/${PAST}/entries`, { text: "Algo importante." })
    fake.responses.create = original
    expect(response.statusCode).toBe(201)
    const entry = response.json<Entry>()
    expect(entry.turns.map((turn) => turn.role)).toEqual(["user"])

    fake.texts.push("Quer contar mais?")
    const retry = (
      await call("POST", `/diary/entries/${entry.id}/turns`, { skip: true })
    ).json<Entry>()
    expect(retry.turns.map((turn) => turn.role)).toEqual(["user", "assistant"])
  })

  it("a entrada concluída vira sinapse, uma única vez", async () => {
    const entry = await startEntry(PAST, "Decidi que vou aprender violão neste ano.")
    await conclude(entry, "Decidi aprender violão.")
    fake.parsed.push({
      items: [
        {
          action: "create",
          sinapseId: "",
          title: "Violão",
          emoji: "🎸",
          summary: "O usuário decidiu aprender violão.",
          sectionTitle: "",
          content: "## Meta\n\nAprender violão em 2026.",
          tags: ["musica"],
          reason: "Decisão registrada no diário",
        },
      ],
      links: [],
    })
    await runJobNow("diary.memorize", { entryId: entry.id })
    const [created] = await db.select().from(sinapses).where(eq(sinapses.title, "Violão"))
    expect(created?.content).toContain("Aprender violão")
    const memoryRequest = fake.requests.at(-1) as unknown as { input: string; instructions: string }
    expect(memoryRequest.input).toContain("Entrada nova do diário")
    expect(memoryRequest.instructions).toContain("diário pessoal")

    // Rodar de novo não repete a escrita.
    const before = fake.requests.length
    await runJobNow("diary.memorize", { entryId: entry.id })
    expect(fake.requests).toHaveLength(before)
  })

  it("o chat consulta o diário pelas tools search_diary e read_diary_day", async () => {
    const entry = await startEntry(PAST, "Comecei a correr de manhã.")
    await conclude(entry, "Comecei a correr de manhã e me senti ótimo.")
    const found = await searchDiary("correr de manhã")
    expect(found[0]).toMatchObject({ date: PAST })
    expect(found[0]!.excerpt).toContain("correr")

    const conversation = (await call("POST", "/conversations", {})).json<{ id: string }>()
    fake.rounds = [
      functionCallRound("read_diary_day", { date: PAST }),
      textRound("Você começou a correr!"),
    ]
    const response = await call("POST", `/conversations/${conversation.id}/messages`, {
      parentId: null,
      text: "O que eu fiz em 10 de janeiro?",
    })
    expect(parseSse(response.payload).some((event) => event.event === "done")).toBe(true)
    const requests = fake.requests.filter((req) => req.stream) as unknown as {
      tools: { name?: string }[]
      input: { type?: string; output?: string }[]
    }[]
    expect(requests[0]!.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["search_diary", "read_diary_day"]),
    )
    const output = requests[1]!.input.find((item) => item.type === "function_call_output")
    expect(output?.output).toContain("Comecei a correr")

    // Conversa anônima não vê o diário.
    const anonymous = (await call("POST", "/conversations", { anonymous: true })).json<{
      id: string
    }>()
    fake.rounds = [textRound("ok")]
    fake.requests = []
    await call("POST", `/conversations/${anonymous.id}/messages`, { parentId: null, text: "oi" })
    const anonRequest = fake.requests.find((req) => req.stream) as unknown as {
      tools: { name?: string }[]
    }
    expect(anonRequest.tools.map((tool) => tool.name)).not.toContain("search_diary")
  })
})
