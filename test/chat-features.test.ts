import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { buildApp } from "../src/app.js"
import { db } from "../src/db/client.js"
import {
  conversations,
  conversationSummaries,
  fileChunks,
  files,
  messages,
  sinapses,
  usageEvents,
} from "../src/db/schema.js"
import { enqueuedJobs, runJobNow } from "../src/lib/jobs.js"
import { setOpenAIClient } from "../src/lib/openai.js"
import { setStorage } from "../src/lib/r2.js"
import { resetContainers } from "../src/modules/chat/code-interpreter.js"
import { htmlToText, isPublicAddress } from "../src/modules/chat/fetch-url.js"
import { activeRun, createRun } from "../src/modules/chat/runs.js"
import { createSinapse } from "../src/modules/sinapses/service.js"
import {
  FakeOpenAI,
  FakeStorage,
  fakeVector,
  functionCallRound,
  parseSse,
  resetData,
  textRound,
  usage,
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
  fake.texts = []
  fake.requests = []
  fake.containerCalls = []
  fake.failNext = null
  enqueuedJobs.length = 0
  resetContainers()
})

type Part = { type: string; [key: string]: unknown }
type SavedMessage = {
  id: string
  status: string
  content: Part[]
  contentText: string
  parentId: string
  error: string | null
  costUsd: number
}
type StreamRequest = {
  instructions: string
  input: { role?: string; type?: string; content?: unknown; output?: string }[]
  tools?: { type: string; name?: string; container?: string }[]
  include?: string[]
  temperature?: number
}

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

function post(conversationId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/conversations/${conversationId}/messages`,
    headers: auth,
    payload: { parentId: null, ...payload },
  })
}

async function send(conversationId: string, payload: Record<string, unknown>) {
  const response = await post(conversationId, payload)
  expect(response.statusCode).toBe(200)
  return parseSse(response.payload)
}

const doneMessage = (events: ReturnType<typeof parseSse>) =>
  events.find((event) => event.event === "done")!.data.message as SavedMessage

const streamRequests = () => fake.requests.filter((req) => req.stream) as StreamRequest[]

const textOfInput = (item: StreamRequest["input"][number]) =>
  typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? item.output)

describe("geração desacoplada da conexão (D68)", () => {
  it("quem se reconecta recebe a resposta desde o começo; depois do fim, 204", async () => {
    const id = await newConversation()
    fake.rounds = [textRound("Uma resposta longa o bastante para durar alguns ms. ".repeat(4))]
    const first = post(id, { text: "Oi" })
    await vi.waitFor(() => expect(activeRun(id)).toBeDefined())

    const resumed = await app.inject({
      method: "GET",
      url: `/conversations/${id}/stream`,
      headers: auth,
    })
    const original = parseSse((await first).payload)
    const replay = parseSse(resumed.payload)
    expect(replay.map((event) => event.event)).toEqual(original.map((event) => event.event))
    expect(doneMessage(replay).status).toBe("completed")
    // Tokens reais da primeira rodada, para o medidor de contexto (D67).
    expect(doneMessage(replay)).toMatchObject({ contextTokens: 100 })

    const after = await app.inject({
      method: "GET",
      url: `/conversations/${id}/stream`,
      headers: auth,
    })
    expect(after.statusCode).toBe(204)
  })

  it("parar é um pedido explícito e salva o parcial como `stopped`", async () => {
    const id = await newConversation()
    fake.rounds = [textRound("Era uma vez um reino muito, muito distante. ".repeat(20))]
    const running = post(id, { text: "Conte uma história" })
    await vi.waitFor(() =>
      expect(activeRun(id)?.events.some((event) => event.event === "delta")).toBe(true),
    )
    const stop = await app.inject({
      method: "POST",
      url: `/conversations/${id}/stop`,
      headers: auth,
    })
    expect(stop.json()).toEqual({ stopped: true })
    const saved = doneMessage(parseSse((await running).payload))
    expect(saved.status).toBe("stopped")
    expect(saved.contentText.length).toBeGreaterThan(0)

    const nothing = await app.inject({
      method: "POST",
      url: `/conversations/${id}/stop`,
      headers: auth,
    })
    expect(nothing.json()).toEqual({ stopped: false })
  })

  it("a trava é síncrona: a segunda resposta na mesma conversa é recusada", () => {
    const run = createRun("00000000-0000-4000-8000-0000000000aa")
    expect(() => createRun("00000000-0000-4000-8000-0000000000aa")).toThrow(/terminar/)
    run.discard()
    createRun("00000000-0000-4000-8000-0000000000aa").discard()
  })
})

describe("orçamento de contexto (D67)", () => {
  it("resume o começo do ramo quando passa do teto e reaproveita o resumo", async () => {
    await app.inject({
      method: "PATCH",
      url: "/settings",
      headers: auth,
      payload: { contextBudgetTokens: 8_000 },
    })
    try {
      const id = await newConversation()
      let parentId: string | null = null
      for (let turn = 0; turn < 10; turn++) {
        for (const role of ["user", "assistant"] as const) {
          const text = `Mensagem ${turn} (${role}). ${"conteúdo longo da conversa ".repeat(160)}`
          const [row]: { id: string }[] = await db
            .insert(messages)
            .values({
              conversationId: id,
              parentId,
              role,
              content: [{ type: "text", text }],
              contentText: text,
              createdAt: new Date(
                Date.now() - (40 - turn * 2) * 60_000 + (role === "user" ? 0 : 1),
              ),
            })
            .returning({ id: messages.id })
          parentId = row!.id
        }
      }
      await db
        .update(conversations)
        .set({ currentLeafMessageId: parentId })
        .where(eq(conversations.id, id))

      fake.texts = ["RESUMO: o usuário conversou sobre conteúdo longo."]
      fake.rounds = [textRound("ok")]
      const events = await send(id, { text: "E agora?", parentId })
      const compacted = events.find(
        (event) => event.event === "part" && event.data.type === "compacted",
      )
      expect(compacted?.data.messages).toBeGreaterThan(10)

      const request = streamRequests()[0]!
      expect(request.input[0]).toMatchObject({ role: "developer" })
      expect(textOfInput(request.input[0]!)).toContain("RESUMO: o usuário conversou")
      expect(request.input.length).toBeLessThan(15)
      const saved = await db
        .select()
        .from(conversationSummaries)
        .where(eq(conversationSummaries.conversationId, id))
      expect(saved).toHaveLength(1)

      // Próxima mensagem: usa o mesmo resumo, sem resumir de novo.
      const nonStream = fake.requests.filter((req) => !req.stream).length
      fake.rounds = [textRound("ok de novo")]
      await send(id, { text: "Mais uma", parentId: doneMessage(events).id })
      expect(fake.requests.filter((req) => !req.stream).length).toBe(nonStream)
      expect(textOfInput(streamRequests().at(-1)!.input[0]!)).toContain("RESUMO")
    } finally {
      await app.inject({
        method: "PATCH",
        url: "/settings",
        headers: auth,
        payload: { contextBudgetTokens: 60_000 },
      })
    }
  })
})

describe("resposta cortada e continuar (D69)", () => {
  it("marca `incomplete` e continuar cria uma nova versão com o texto inteiro", async () => {
    const id = await newConversation()
    fake.rounds = [
      [
        { type: "response.output_text.delta", delta: "Começo da resp" },
        {
          type: "response.incomplete",
          response: {
            output: [],
            usage: usage(),
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      ],
    ]
    const cut = doneMessage(await send(id, { text: "Explique tudo" }))
    expect(cut.status).toBe("incomplete")
    expect(cut.error).toContain("limite de tamanho")

    fake.rounds = [textRound("osta.")]
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${id}/messages/${cut.id}/continue`,
      headers: auth,
      payload: {},
    })
    const continued = doneMessage(parseSse(response.payload))
    expect(continued.contentText).toBe("Começo da resposta.")
    expect(continued.parentId).toBe(cut.parentId)
    expect(continued.status).toBe("completed")
    const request = streamRequests().at(-1)!
    expect(textOfInput(request.input.at(-1)!)).toContain("Continue exatamente")
    expect(request.input.at(-2)).toMatchObject({ role: "assistant", content: "Começo da resp" })

    const again = await app.inject({
      method: "POST",
      url: `/conversations/${id}/messages/${continued.id}/continue`,
      headers: auth,
      payload: {},
    })
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toBe("not_continuable")
  })
})

describe("histórico completo para o modelo (1d)", () => {
  it("devolve fontes e imagens geradas das respostas anteriores", async () => {
    const id = await newConversation()
    const [image] = await db
      .insert(files)
      .values({
        r2Key: "generated/teste/gato.webp",
        name: "gato.webp",
        mime: "image/webp",
        size: 10,
        origin: "generated",
        conversationId: id,
        status: "ready",
      })
      .returning()
    const [user] = await db
      .insert(messages)
      .values({
        conversationId: id,
        role: "user",
        content: [{ type: "text", text: "Desenhe um gato" }],
        contentText: "Desenhe um gato",
        createdAt: new Date(Date.now() - 60_000),
      })
      .returning()
    const [assistant] = await db
      .insert(messages)
      .values({
        conversationId: id,
        parentId: user!.id,
        role: "assistant",
        content: [
          { type: "text", text: "Aqui está." },
          { type: "image", fileId: image!.id, prompt: "um gato laranja" },
          { type: "sources", items: [{ url: "https://exemplo.com/gatos", title: "Gatos" }] },
        ],
        contentText: "Aqui está.",
        createdAt: new Date(Date.now() - 50_000),
      })
      .returning()

    fake.rounds = [textRound("Feito")]
    await send(id, { text: "Agora com fundo azul", parentId: assistant!.id })
    const input = streamRequests()[0]!.input
    const previous = input.find((item) => item.role === "assistant")!
    expect(previous.content).toContain("https://exemplo.com/gatos")
    expect(previous.content).toContain("um gato laranja")
    const attached = JSON.stringify(input)
    expect(attached).toContain("r2.test/generated/teste/gato.webp")
    expect(attached).toContain("Anexo automático do app")
  })
})

describe("temperatura (D71)", () => {
  it("modelo que recusa temperatura: tenta de novo sem e não manda mais", async () => {
    const id = await newConversation({ model: "gpt-temp-teste", settings: { temperature: 0.3 } })
    fake.failNext = Object.assign(
      new Error("400 Unsupported parameter: 'temperature' is not supported with this model."),
      { status: 400 },
    )
    fake.rounds = [textRound("ok")]
    const saved = doneMessage(await send(id, { text: "Oi" }))
    expect(saved.status).toBe("completed")
    const [refused, retried] = streamRequests()
    expect(refused!.temperature).toBe(0.3)
    expect(retried!.temperature).toBeUndefined()

    fake.rounds = [textRound("ok")]
    await send(id, { text: "De novo", parentId: saved.id })
    expect(streamRequests().at(-1)!.temperature).toBeUndefined()
  })
})

describe("menções de sinapse (D76)", () => {
  it("a sinapse mencionada entra inteira no contexto e fica na mensagem", async () => {
    const { sinapse } = await createSinapse(
      {
        title: "Receita de pão",
        summary: "Receita de pão caseiro.",
        content: "## Ingredientes\n\n- Farinha 500g\n- Fermento 10g",
      },
      { author: "user" },
    )
    const id = await newConversation()
    fake.rounds = [textRound("ok")]
    const events = await send(id, { text: "Dá para dobrar?", sinapseIds: [sinapse.id] })
    const user = events.find((event) => event.event === "start")!.data.userMessage as {
      content: Part[]
    }
    expect(user.content).toContainEqual({
      type: "mention",
      sinapseId: sinapse.id,
      title: "Receita de pão",
    })
    expect(JSON.stringify(streamRequests()[0]!.input)).toContain("Farinha 500g")

    const anonymous = await newConversation({ anonymous: true })
    const refused = await post(anonymous, { text: "Oi", sinapseIds: [sinapse.id] })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error).toBe("anonymous_memory")
  })
})

describe("sugestões da tela inicial (D72)", () => {
  it("personaliza a partir da memória e guarda em cache", async () => {
    fake.parsed = [{ suggestions: ["Retomar a receita de pão", "Planejar a semana"] }]
    const first = await app.inject({ method: "GET", url: "/chat/suggestions", headers: auth })
    expect(first.json()).toEqual({
      suggestions: ["Retomar a receita de pão", "Planejar a semana"],
      personalized: true,
    })
    const calls = fake.requests.length
    const second = await app.inject({ method: "GET", url: "/chat/suggestions", headers: auth })
    expect(second.json().suggestions).toEqual(["Retomar a receita de pão", "Planejar a semana"])
    expect(fake.requests.length).toBe(calls)
  })
})

describe("ler páginas (D75)", () => {
  it("bloqueia endereços internos", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.10", "::1"]) {
      expect(isPublicAddress(address)).toBe(false)
    }
    expect(isPublicAddress("::ffff:10.0.0.1")).toBe(false)
    expect(isPublicAddress("fd00::1")).toBe(false)
    expect(isPublicAddress("8.8.8.8")).toBe(true)
    expect(isPublicAddress("2606:4700::1111")).toBe(true)
  })

  it("converte HTML em texto legível, sem scripts nem menus", () => {
    const { title, text } = htmlToText(
      "<html><head><title>Notícia &amp; mais</title><script>alert(1)</script></head>" +
        "<body><nav>Menu</nav><h1>Título</h1><p>Primeiro&nbsp;parágrafo.</p><ul><li>Um</li></ul></body></html>",
    )
    expect(title).toBe("Notícia & mais")
    expect(text).toContain("# Título")
    expect(text).toContain("Primeiro parágrafo.")
    expect(text).toContain("- Um")
    expect(text).not.toContain("alert")
    expect(text).not.toContain("Menu")
  })

  it("a tool devolve o erro ao modelo e marca o contexto como externo", async () => {
    const id = await newConversation()
    fake.rounds = [
      functionCallRound("fetch_url", { url: "http://127.0.0.1:8080/admin" }),
      functionCallRound("create_sinapse", {
        title: "Algo da página",
        emoji: "📄",
        summary: "Lido numa página.",
        content: "texto",
        tags: [],
      }),
      textRound("Não consegui abrir."),
    ]
    const events = await send(id, { text: "Leia http://127.0.0.1:8080/admin" })
    const output = streamRequests()[1]!.input.find((item) => item.type === "function_call_output")
    expect(output?.output).toContain("rede interna")
    const parts = events.filter((event) => event.event === "part").map((event) => event.data)
    expect(parts).toContainEqual({
      type: "tool",
      name: "fetch_url",
      detail: "http://127.0.0.1:8080/admin",
    })
    // D37: com página no contexto, a escrita na memória vira sugestão.
    expect(parts).toContainEqual(expect.objectContaining({ type: "sinapse", action: "suggested" }))
  })
})

describe("interpretador de código (D74)", () => {
  it("cria o container, envia os anexos e guarda os arquivos gerados", async () => {
    const id = await newConversation()
    const key = "uploads/teste/dados.csv"
    storage.objects.set(key, Buffer.from("a,b\n1,2\n"))
    const [csv] = await db
      .insert(files)
      .values({
        r2Key: key,
        name: "dados.csv",
        mime: "text/csv",
        size: 8,
        status: "ready",
        extractedText: "a,b\n1,2",
      })
      .returning()
    const call = {
      type: "code_interpreter_call",
      id: "ci_1",
      code: "import pandas as pd\nprint(pd.read_csv('dados.csv').sum())",
      container_id: "cntr_1",
      outputs: [{ type: "logs", logs: "a 1\nb 2" }],
      status: "completed",
    }
    const message = {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "Pronto: [resultado.csv](sandbox:/mnt/data/resultado.csv)",
          annotations: [
            {
              type: "container_file_citation",
              container_id: "cntr_1",
              file_id: "cfile_1",
              filename: "resultado.csv",
              start_index: 0,
              end_index: 10,
            },
          ],
        },
      ],
    }
    fake.rounds = [
      [
        { type: "response.code_interpreter_call.interpreting" },
        { type: "response.output_item.done", item: call },
        { type: "response.output_text.delta", delta: "Pronto" },
        { type: "response.output_item.done", item: message },
        { type: "response.completed", response: { output: [call, message], usage: usage() } },
      ],
    ]
    const events = await send(id, {
      text: "Some as colunas",
      fileIds: [csv!.id],
      codeInterpreter: true,
    })
    const saved = doneMessage(events)
    expect(saved.content).toContainEqual(
      expect.objectContaining({ type: "code", logs: "a 1\nb 2" }),
    )
    const generated = saved.content.find((part) => part.type === "file")
    expect(generated).toMatchObject({ name: "resultado.csv", mime: "text/csv" })
    expect(fake.containerCalls.map((item) => item.op)).toEqual(["create", "upload", "download"])
    expect(fake.containerCalls[1]!.args).toEqual(["cntr_1", "dados.csv"])

    const request = streamRequests()[0]!
    expect(request.tools).toContainEqual({ type: "code_interpreter", container: "cntr_1" })
    expect(request.include).toContain("code_interpreter_call.outputs")
    const [cost] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.model, "code_interpreter"))
    expect(cost?.costUsd).toBeCloseTo(0.03)

    // Mesmo container na próxima mensagem, sem reenviar o arquivo.
    fake.containerCalls = []
    fake.rounds = [textRound("ok")]
    await send(id, { text: "E a média?", parentId: saved.id, codeInterpreter: true })
    expect(fake.containerCalls.map((item) => item.op)).toEqual(["retrieve"])
  })
})

describe("feedback (D77)", () => {
  it("👎 com comentário vira preferência na sinapse fixada, sem duplicar", async () => {
    const id = await newConversation()
    fake.rounds = [textRound("Uma resposta enorme e cheia de rodeios.")]
    const answer = doneMessage(await send(id, { text: "Como faço café?" }))

    const rated = await app.inject({
      method: "PUT",
      url: `/conversations/${id}/messages/${answer.id}/feedback`,
      headers: auth,
      payload: { rating: "down", note: "Longo demais, quero direto ao ponto" },
    })
    expect(rated.json()).toMatchObject({
      rating: "down",
      feedbackNote: "Longo demais, quero direto ao ponto",
    })
    expect(enqueuedJobs.map((job) => job.name)).toContain("feedback.learn")

    fake.parsed = [{ preference: "Prefere respostas curtas e diretas." }]
    await runJobNow("feedback.learn", { messageId: answer.id })
    const [prefs] = await db
      .select()
      .from(sinapses)
      .where(eq(sinapses.title, "Preferências de resposta"))
    expect(prefs?.pinned).toBe(true)
    expect(prefs?.content).toContain("- Prefere respostas curtas e diretas.")

    fake.parsed = [{ preference: "Prefere respostas curtas e diretas." }]
    await runJobNow("feedback.learn", { messageId: answer.id })
    const [again] = await db.select().from(sinapses).where(eq(sinapses.id, prefs!.id))
    expect(again!.content.match(/curtas e diretas/g)).toHaveLength(1)

    const cleared = await app.inject({
      method: "PUT",
      url: `/conversations/${id}/messages/${answer.id}/feedback`,
      headers: auth,
      payload: { rating: null },
    })
    expect(cleared.json()).toMatchObject({ rating: null, feedbackNote: null })

    const onUser = await app.inject({
      method: "PUT",
      url: `/conversations/${id}/messages/${answer.parentId}/feedback`,
      headers: auth,
      payload: { rating: "up" },
    })
    expect(onUser.statusCode).toBe(400)
  })
})

describe("abrir em nova conversa (fork)", () => {
  it("copia o ramo até a mensagem escolhida", async () => {
    const id = await newConversation()
    fake.rounds = [textRound("Primeira resposta"), textRound("Segunda resposta")]
    const first = doneMessage(await send(id, { text: "Pergunta 1" }))
    await send(id, { text: "Pergunta 2", parentId: first.id })
    await app.inject({
      method: "PATCH",
      url: `/conversations/${id}`,
      headers: auth,
      payload: { title: "Original" },
    })

    const fork = await app.inject({
      method: "POST",
      url: `/conversations/${id}/fork`,
      headers: auth,
      payload: { messageId: first.id },
    })
    expect(fork.statusCode).toBe(201)
    const copy = fork.json<{ id: string; title: string; currentLeafMessageId: string }>()
    expect(copy.title).toBe("Original (cópia)")
    const detail = (
      await app.inject({ method: "GET", url: `/conversations/${copy.id}`, headers: auth })
    ).json<{ messages: SavedMessage[] }>()
    expect(detail.messages.map((message) => message.contentText)).toEqual([
      "Pergunta 1",
      "Primeira resposta",
    ])
    expect(copy.currentLeafMessageId).toBe(detail.messages[1]!.id)
    expect(detail.messages[1]!.parentId).toBe(detail.messages[0]!.id)
  })
})

describe("projetos (D73)", () => {
  it("instruções, sinapses e arquivos do projeto entram nas conversas dele", async () => {
    const { sinapse } = await createSinapse(
      { title: "Casa nova", summary: "Mudança.", content: "Mudança prevista para março." },
      { author: "user" },
    )
    const created = await app.inject({
      method: "POST",
      url: "/folders",
      headers: auth,
      payload: {
        name: "Reforma",
        instructions: "Orçamento máximo de R$ 300 mil.",
        sinapseIds: [sinapse.id],
      },
    })
    expect(created.statusCode).toBe(201)
    const folder = created.json<{ id: string; instructions: string; sinapseIds: string[] }>()
    expect(folder.sinapseIds).toEqual([sinapse.id])

    const badSinapse = await app.inject({
      method: "PATCH",
      url: `/folders/${folder.id}`,
      headers: auth,
      payload: { sinapseIds: ["00000000-0000-4000-8000-000000000000"] },
    })
    expect(badSinapse.statusCode).toBe(404)

    const upload = await app.inject({
      method: "POST",
      url: "/files",
      headers: auth,
      payload: { name: "planta.txt", mime: "text/plain", size: 10, folderId: folder.id },
    })
    expect(upload.json().file.folderId).toBe(folder.id)
    const chunkText = "A planta da cozinha americana tem doze metros quadrados"
    await db
      .update(files)
      .set({ status: "ready", extractedText: chunkText })
      .where(eq(files.id, upload.json().file.id))
    await db.insert(fileChunks).values({
      fileId: upload.json().file.id,
      idx: 0,
      text: chunkText,
      embeddingModel: "text-embedding-3-small",
      embedding: fakeVector(`planta.txt\n\n${chunkText}`),
    })

    const id = await newConversation({ folderId: folder.id })
    fake.rounds = [textRound("ok")]
    await send(id, { text: "Como é a planta da cozinha americana?" })
    const request = streamRequests()[0]!
    expect(request.instructions).toContain("## Projeto: Reforma")
    expect(request.instructions).toContain("Orçamento máximo de R$ 300 mil.")
    expect(request.instructions).toContain("Mudança prevista para março.")
    expect(JSON.stringify(request.input)).toContain("doze metros quadrados")

    const listed = await app.inject({
      method: "GET",
      url: `/files?folderId=${folder.id}`,
      headers: auth,
    })
    expect(listed.json().files).toHaveLength(1)
  })
})
