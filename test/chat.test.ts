import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { buildApp } from "../src/app.js"
import { db } from "../src/db/client.js"
import { conversations, messages, sinapseSuggestions, sinapses } from "../src/db/schema.js"
import { enqueuedJobs, runJobNow } from "../src/lib/jobs.js"
import { setOpenAIClient } from "../src/lib/openai.js"
import { setStorage } from "../src/lib/r2.js"
import { generateReply } from "../src/modules/chat/orchestrator.js"
import { getConversation } from "../src/modules/conversations/service.js"
import {
  FakeOpenAI,
  FakeStorage,
  functionCallRound,
  parseSse,
  resetData,
  textRound,
  webSearchItem,
} from "./fakes.js"
import { bearer, loginToken } from "./helpers.js"

const app = await buildApp()
const fake = new FakeOpenAI()
const storage = new FakeStorage()
let auth: Record<string, string>

beforeAll(async () => {
  await app.ready()
  await resetData()
  setOpenAIClient(fake.asClient())
  setStorage(storage)
  auth = bearer(await loginToken(app))
})
afterAll(async () => {
  setOpenAIClient(undefined)
  setStorage(undefined)
  await app.close()
})
beforeEach(() => {
  fake.rounds = []
  fake.parsed = []
  fake.requests = []
  enqueuedJobs.length = 0
})

async function newConversation(body: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/conversations",
    headers: auth,
    payload: body,
  })
  expect(response.statusCode).toBe(201)
  return response.json<{ id: string }>().id
}

async function send(conversationId: string, payload: Record<string, unknown>) {
  const response = await app.inject({
    method: "POST",
    url: `/conversations/${conversationId}/messages`,
    headers: auth,
    payload: { parentId: null, ...payload },
  })
  expect(response.statusCode).toBe(200)
  expect(response.headers["content-type"]).toContain("text/event-stream")
  return parseSse(response.payload)
}

const doneMessage = (events: ReturnType<typeof parseSse>) =>
  events.find((event) => event.event === "done")!.data.message as {
    id: string
    status: string
    content: { type: string; [key: string]: unknown }[]
    contentText: string
    tokensIn: number
    costUsd: number
    parentId: string
  }

describe("chat em streaming", () => {
  it("transmite a resposta e grava pergunta e resposta no histórico", async () => {
    const id = await newConversation()
    fake.rounds = [textRound("Olá! Tudo certo por aqui.")]

    const events = await send(id, { text: "Oi" })
    const names = events.map((event) => event.event)
    expect(names[0]).toBe("start")
    expect(names).toContain("delta")
    expect(names.at(-1)).toBe("done")
    const text = events
      .filter((event) => event.event === "delta")
      .map((event) => event.data.text)
      .join("")
    expect(text).toBe("Olá! Tudo certo por aqui.")

    const message = doneMessage(events)
    expect(message.status).toBe("completed")
    expect(message.tokensIn).toBe(100)

    const rows = await db.select().from(messages).where(eq(messages.conversationId, id))
    expect(rows.map((row) => row.role).sort()).toEqual(["assistant", "user"])
    const conversation = await getConversation(id)
    expect(conversation.currentLeafMessageId).toBe(message.id)

    // Jobs de título, embeddings e consolidação foram enfileirados.
    expect(enqueuedJobs.map((job) => job.name).sort()).toEqual([
      "conversation.title",
      "messages.embed",
      "sinapses.consolidate",
    ])
  })

  it("instruções ficam estáveis e a memória entra no contexto (D41)", async () => {
    const id = await newConversation()
    fake.rounds = [textRound("ok")]
    await send(id, { text: "Oi" })
    const request = fake.requests.find((req) => req.stream) as {
      instructions: string
      input: unknown[]
      store: boolean
    }
    expect(request.instructions).toContain("Sobre mim")
    expect(request.instructions).toContain("pt-BR")
    expect(request.store).toBe(false)
  })

  it("executa as tools de sinapse em loop e emite o chip", async () => {
    const id = await newConversation()
    fake.rounds = [
      functionCallRound("create_sinapse", {
        title: "Ideias de viagem",
        emoji: "✈️",
        summary: "Lugares que o usuário quer conhecer.",
        content: "## Destinos\n\n- Patagônia",
        tags: ["viagem"],
      }),
      textRound("Anotado!"),
    ]
    const events = await send(id, { text: "Quero muito conhecer a Patagônia um dia." })
    const chip = events.find((event) => event.event === "part" && event.data.type === "sinapse")
    expect(chip?.data).toMatchObject({ action: "created", title: "Ideias de viagem" })

    const [created] = await db.select().from(sinapses).where(eq(sinapses.title, "Ideias de viagem"))
    expect(created?.content).toContain("Patagônia")
    // A segunda rodada recebeu o resultado da função.
    const second = fake.requests.filter((req) => req.stream)[1] as { input: { type?: string }[] }
    expect(second.input.some((item) => item.type === "function_call_output")).toBe(true)
  })

  it("com busca web no contexto, a escrita na memória vira sugestão (D37)", async () => {
    const id = await newConversation()
    fake.rounds = [
      [
        { type: "response.output_item.done", item: webSearchItem("notícias") },
        ...functionCallRound("create_sinapse", {
          title: "Notícia qualquer",
          emoji: "📰",
          summary: "Algo lido na web.",
          content: "texto",
          tags: [],
        }),
      ],
      textRound("Feito."),
    ]
    const events = await send(id, { text: "Pesquise e guarde", webSearch: true })
    const chip = events.find((event) => event.event === "part" && event.data.type === "sinapse")
    expect(chip?.data).toMatchObject({ action: "suggested" })
    const suggestions = await db
      .select()
      .from(sinapseSuggestions)
      .where(eq(sinapseSuggestions.status, "pending"))
    expect(suggestions.length).toBeGreaterThan(0)
    expect(
      await db.select().from(sinapses).where(eq(sinapses.title, "Notícia qualquer")),
    ).toHaveLength(0)
  })

  it("regenerar cria uma resposta irmã e a folha pode voltar para a anterior", async () => {
    const id = await newConversation()
    fake.rounds = [textRound("Primeira"), textRound("Segunda")]
    const first = doneMessage(await send(id, { text: "Pergunta" }))

    const response = await app.inject({
      method: "POST",
      url: `/conversations/${id}/messages/${first.id}/regenerate`,
      headers: auth,
      payload: {},
    })
    const second = doneMessage(parseSse(response.payload))
    expect(second.parentId).toBe(first.parentId)
    expect(second.contentText).toBe("Segunda")

    const back = await app.inject({
      method: "PUT",
      url: `/conversations/${id}/leaf`,
      headers: auth,
      payload: { messageId: first.id },
    })
    expect(back.json().currentLeafMessageId).toBe(first.id)
  })

  it("parar no meio salva o parcial como `stopped`", async () => {
    const id = await newConversation()
    const conversation = await getConversation(id)
    const [user] = await db
      .insert(messages)
      .values({
        conversationId: id,
        role: "user",
        content: [{ type: "text", text: "Conte uma história" }],
        contentText: "Conte uma história",
      })
      .returning()
    const [assistant] = await db
      .insert(messages)
      .values({ conversationId: id, parentId: user!.id, role: "assistant", status: "streaming" })
      .returning()

    fake.rounds = [textRound("Era uma vez um reino muito, muito distante onde...")]
    const controller = new AbortController()
    let deltas = 0
    const saved = await generateReply({
      conversation,
      userMessage: user!,
      assistantMessageId: assistant!.id,
      options: {},
      signal: controller.signal,
      emit: (event) => {
        if (event === "delta" && ++deltas === 2) controller.abort()
      },
    })
    expect(saved.status).toBe("stopped")
    expect(saved.contentText?.length).toBeGreaterThan(0)
    expect(saved.contentText!.length).toBeLessThan(
      "Era uma vez um reino muito, muito distante onde...".length,
    )
  })

  it("conversa anônima não usa memória nem tools de sinapse", async () => {
    const id = await newConversation({ anonymous: true })
    fake.rounds = [textRound("ok")]
    await send(id, { text: "Segredo" })
    const request = fake.requests.find((req) => req.stream) as {
      instructions: string
      tools?: { name?: string }[]
    }
    expect(request.instructions).toContain("anônima")
    // Só a leitura de páginas (não é memória); nenhuma tool de sinapse.
    expect(request.tools?.map((tool) => tool.name)).toEqual(["fetch_url"])
    expect(enqueuedJobs.some((job) => job.name === "sinapses.consolidate")).toBe(false)
  })

  it("recusa outra mensagem enquanto a resposta está em andamento (D66)", async () => {
    const id = await newConversation()
    fake.rounds = [textRound("uma resposta comprida o bastante para durar alguns ms")]
    const post = () =>
      app.inject({
        method: "POST",
        url: `/conversations/${id}/messages`,
        headers: auth,
        payload: { parentId: null, text: "oi" },
      })
    // Qualquer uma das duas pode chegar primeiro.
    const results = await Promise.all([post(), post()])
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409])
    const refused = results.find((result) => result.statusCode === 409)!
    expect(refused.json()).toMatchObject({ error: "reply_in_progress" })

    // Terminada a resposta, a conversa volta a aceitar mensagens.
    const userMessages = await db.select().from(messages).where(eq(messages.conversationId, id))
    expect(userMessages.filter((message) => message.role === "user")).toHaveLength(1)
    const events = await send(id, { text: "de novo" })
    expect(doneMessage(events).status).toBe("completed")
  })

  it("recusa mensagem vazia e pai de outra conversa", async () => {
    const id = await newConversation()
    const empty = await app.inject({
      method: "POST",
      url: `/conversations/${id}/messages`,
      headers: auth,
      payload: { parentId: null, text: "  " },
    })
    expect(empty.statusCode).toBe(400)
    expect(empty.json().error).toBe("empty_message")

    const wrongParent = await app.inject({
      method: "POST",
      url: `/conversations/${id}/messages`,
      headers: auth,
      payload: { parentId: "00000000-0000-4000-8000-000000000000", text: "oi" },
    })
    expect(wrongParent.statusCode).toBe(404)
  })

  it("job de título dá nome à conversa", async () => {
    const id = await newConversation()
    fake.rounds = [textRound("Resposta")]
    await send(id, { text: "Como funciona um motor a jato?" })
    await runJobNow("conversation.title", { conversationId: id })
    const [row] = await db.select().from(conversations).where(eq(conversations.id, id))
    expect(row?.title).toBe("Título de teste")
  })
})
