import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildApp } from "../src/app.js"
import { db } from "../src/db/client.js"
import { fileChunks, files, modelCatalog, usageEvents } from "../src/db/schema.js"
import { enqueuedJobs, runJobNow } from "../src/lib/jobs.js"
import { setOpenAIClient } from "../src/lib/openai.js"
import { clearPriceCache } from "../src/lib/pricing.js"
import { setStorage } from "../src/lib/r2.js"
import { FakeOpenAI, FakeStorage, resetData } from "./fakes.js"
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

describe("modelos", () => {
  it("sincroniza: classifica, esconde snapshots e não inventa preço", async () => {
    fake.parsed = [{ displayName: "GPT Novo X", recommendation: "Desconhecido.", example: "Oi" }]
    const sync = await app.inject({ method: "POST", url: "/models/sync", headers: auth })
    expect(sync.json()).toMatchObject({ drafted: 1 })

    const chat = (
      await app.inject({ method: "GET", url: "/models?kind=chat", headers: auth })
    ).json()
    const ids = chat.models.map((model: { id: string }) => model.id)
    expect(ids).toEqual(expect.arrayContaining(["gpt-6-sol", "gpt-6-luna", "gpt-novo-x"]))
    expect(ids).not.toContain("gpt-6-sol-2026-01-01") // snapshot fora do seletor
    expect(ids).not.toContain("sora-2")

    const novo = chat.models.find((model: { id: string }) => model.id === "gpt-novo-x")
    expect(novo.inputPrice).toBeNull()
    expect(novo.recommendation).toContain("rascunho automático")
  })

  it("editar preço não é sobrescrito pelo próximo sync", async () => {
    await app.inject({
      method: "PATCH",
      url: "/models/gpt-6-sol",
      headers: auth,
      payload: { inputPrice: 9.99 },
    })
    await app.inject({ method: "POST", url: "/models/sync", headers: auth })
    const [row] = await db.select().from(modelCatalog).where(eq(modelCatalog.id, "gpt-6-sol"))
    expect(row?.inputPrice).toBe(9.99)
    await app.inject({
      method: "PATCH",
      url: "/models/gpt-6-sol",
      headers: auth,
      payload: { inputPrice: 2 },
    })
    clearPriceCache()
  })
})

describe("configurações", () => {
  it("tem padrões, valida e avisa quando precisa reindexar", async () => {
    const initial = (await app.inject({ method: "GET", url: "/settings", headers: auth })).json()
    expect(initial.settings.chatDefaultModel).toBe("gpt-6-sol")

    const invalid = await app.inject({
      method: "PATCH",
      url: "/settings",
      headers: auth,
      payload: { monthlyLimitUsd: -1 },
    })
    expect(invalid.statusCode).toBe(400)

    enqueuedJobs.length = 0
    const changed = await app.inject({
      method: "PATCH",
      url: "/settings",
      headers: auth,
      payload: { embeddingModel: "text-embedding-3-large" },
    })
    expect(changed.json().reindexing).toBe(true)
    expect(enqueuedJobs.map((job) => job.name)).toContain("sinapses.reindex-all")
    await app.inject({
      method: "PATCH",
      url: "/settings",
      headers: auth,
      payload: { embeddingModel: "text-embedding-3-small" },
    })
  })
})

describe("uso e custos", () => {
  it("soma o mês e dispara o alerta (só alerta, D23)", async () => {
    await app.inject({
      method: "PATCH",
      url: "/settings",
      headers: auth,
      payload: { monthlyLimitUsd: 1, alertThreshold: 0.5 },
    })
    await db.insert(usageEvents).values({ source: "chat", model: "gpt-6-sol", costUsd: 0.6 })
    const usage = (await app.inject({ method: "GET", url: "/usage", headers: auth })).json()
    expect(usage.month.alert).toBe("warning")
    expect(usage.byModel[0]).toMatchObject({ model: "gpt-6-sol" })
    expect(usage.days).toHaveLength(1)
  })
})

describe("arquivos", () => {
  it("upload em 2 passos: URL assinada, confirmação e processamento", async () => {
    const start = await app.inject({
      method: "POST",
      url: "/files",
      headers: auth,
      payload: { name: "notas.md", mime: "text/markdown", size: 40 },
    })
    expect(start.statusCode).toBe(201)
    const { file, uploadUrl } = start.json()
    expect(uploadUrl).toContain("r2.test")

    // Sem o objeto no R2, confirmar falha.
    expect(
      (await app.inject({ method: "POST", url: `/files/${file.id}/complete`, headers: auth }))
        .statusCode,
    ).toBe(409)

    const [row] = await db.select().from(files).where(eq(files.id, file.id))
    await storage.put(row!.r2Key, Buffer.from("# Notas\n\nComprar pão e café amanhã."))
    enqueuedJobs.length = 0
    const done = await app.inject({
      method: "POST",
      url: `/files/${file.id}/complete`,
      headers: auth,
    })
    expect(done.json().status).toBe("uploaded")
    expect(enqueuedJobs[0]).toMatchObject({ name: "files.process" })

    await runJobNow("files.process", { fileId: file.id })
    const detail = (
      await app.inject({ method: "GET", url: `/files/${file.id}`, headers: auth })
    ).json()
    expect(detail.file.status).toBe("ready")
    expect(detail.extractedText).toContain("Comprar pão")
    expect(
      await db.select().from(fileChunks).where(eq(fileChunks.fileId, file.id)),
    ).not.toHaveLength(0)
  })

  it("recusa tipo não suportado e arquivo grande demais", async () => {
    const exe = await app.inject({
      method: "POST",
      url: "/files",
      headers: auth,
      payload: { name: "virus.exe", mime: "application/x-msdownload", size: 10 },
    })
    expect(exe.statusCode).toBe(415)
    const huge = await app.inject({
      method: "POST",
      url: "/files",
      headers: auth,
      payload: { name: "a.pdf", mime: "application/pdf", size: 100 * 1024 * 1024 },
    })
    expect(huge.statusCode).toBe(400)
  })
})

describe("conversas, pastas e lixeira", () => {
  it("lixeira: soft delete, restaurar e apagar de vez só da lixeira", async () => {
    const id = (
      await app.inject({
        method: "POST",
        url: "/conversations",
        headers: auth,
        payload: { title: "Teste" },
      })
    ).json().id
    expect(
      (await app.inject({ method: "DELETE", url: `/conversations/${id}/permanent`, headers: auth }))
        .statusCode,
    ).toBe(409)

    await app.inject({ method: "DELETE", url: `/conversations/${id}`, headers: auth })
    const trash = (
      await app.inject({ method: "GET", url: "/conversations?view=trash", headers: auth })
    ).json()
    expect(trash.conversations.map((c: { id: string }) => c.id)).toContain(id)

    await app.inject({ method: "POST", url: `/conversations/${id}/restore`, headers: auth })
    const active = (
      await app.inject({ method: "GET", url: "/conversations", headers: auth })
    ).json()
    expect(active.conversations.map((c: { id: string }) => c.id)).toContain(id)

    await app.inject({ method: "DELETE", url: `/conversations/${id}`, headers: auth })
    expect(
      (await app.inject({ method: "DELETE", url: `/conversations/${id}/permanent`, headers: auth }))
        .statusCode,
    ).toBe(204)
  })

  it("pastas: criar, mover conversa e apagar sem apagar a conversa", async () => {
    const folder = (
      await app.inject({
        method: "POST",
        url: "/folders",
        headers: auth,
        payload: { name: "Trabalho" },
      })
    ).json()
    const id = (
      await app.inject({
        method: "POST",
        url: "/conversations",
        headers: auth,
        payload: { folderId: folder.id },
      })
    ).json().id
    const inFolder = (
      await app.inject({
        method: "GET",
        url: `/conversations?folderId=${folder.id}`,
        headers: auth,
      })
    ).json()
    expect(inFolder.conversations).toHaveLength(1)
    await app.inject({ method: "DELETE", url: `/folders/${folder.id}`, headers: auth })
    const conversation = (
      await app.inject({ method: "GET", url: `/conversations/${id}`, headers: auth })
    ).json()
    expect(conversation.conversation.folderId).toBeNull()
  })
})

describe("voz", () => {
  it("transcreve o áudio enviado por multipart", async () => {
    const boundary = "----teste"
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="a.webm"\r\nContent-Type: audio/webm\r\n\r\n` +
      "audio-falso\r\n" +
      `--${boundary}--\r\n`
    const response = await app.inject({
      method: "POST",
      url: "/audio/transcriptions",
      headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ text: "texto ditado" })
  })

  it("lê em voz alta e cria sessão do modo voz", async () => {
    const speech = await app.inject({
      method: "POST",
      url: "/audio/speech",
      headers: auth,
      payload: { text: "Olá" },
    })
    expect(speech.headers["content-type"]).toBe("audio/mpeg")

    const id = (
      await app.inject({ method: "POST", url: "/conversations", headers: auth, payload: {} })
    ).json().id
    const session = await app.inject({
      method: "POST",
      url: "/realtime/session",
      headers: auth,
      payload: { conversationId: id },
    })
    expect(session.json()).toMatchObject({ clientSecret: "ek_teste" })

    const turns = await app.inject({
      method: "POST",
      url: `/conversations/${id}/voice-turns`,
      headers: auth,
      payload: {
        turns: [
          { role: "user", text: "Oi por voz" },
          { role: "assistant", text: "Olá!" },
        ],
      },
    })
    const saved = turns.json().messages
    expect(saved).toHaveLength(2)
    expect(saved[1].parentId).toBe(saved[0].id)
  })
})

describe("busca no histórico", () => {
  it("acha conversa pela palavra (full-text em português)", async () => {
    const id = (
      await app.inject({
        method: "POST",
        url: "/conversations",
        headers: auth,
        payload: { title: "Viagem" },
      })
    ).json().id
    await app.inject({
      method: "POST",
      url: `/conversations/${id}/voice-turns`,
      headers: auth,
      payload: {
        turns: [{ role: "user", text: "Estou planejando viajar para Florianópolis em janeiro" }],
      },
    })
    const results = (
      await app.inject({
        method: "GET",
        url: "/search?q=florianópolis&semantic=false",
        headers: auth,
      })
    ).json()
    expect(
      results.conversations.map((hit: { conversationId: string }) => hit.conversationId),
    ).toContain(id)
  })
})
