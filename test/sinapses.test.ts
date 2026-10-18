import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { buildApp } from "../src/app.js"
import { db } from "../src/db/client.js"
import { conversations, messages, sinapseSuggestions, sinapses } from "../src/db/schema.js"
import { enqueuedJobs } from "../src/lib/jobs.js"
import { setOpenAIClient } from "../src/lib/openai.js"
import { consolidateConversation } from "../src/modules/sinapses/consolidation.js"
import { applySectionOperation } from "../src/modules/sinapses/service.js"
import { FakeOpenAI, resetData } from "./fakes.js"
import { bearer, loginToken } from "./helpers.js"

const app = await buildApp()
const fake = new FakeOpenAI()
let auth: Record<string, string>

beforeAll(async () => {
  await app.ready()
  await resetData()
  setOpenAIClient(fake.asClient())
  auth = bearer(await loginToken(app))
})
afterAll(async () => {
  setOpenAIClient(undefined)
  await app.close()
})
beforeEach(() => {
  fake.parsed = []
  enqueuedJobs.length = 0
})

async function create(
  title: string,
  content = `## Notas\n\nSobre ${title}.`,
  summary = `Tudo sobre ${title}.`,
) {
  const response = await app.inject({
    method: "POST",
    url: "/sinapses",
    headers: auth,
    payload: { title, summary, content, tags: ["Teste Tag"] },
  })
  expect(response.statusCode).toBe(201)
  return response.json<{ id: string; tags: string[] }>()
}

describe("CRUD e versões", () => {
  it("cria com tags normalizadas, edita e guarda cada versão", async () => {
    const created = await create("Carreira")
    expect(created.tags).toEqual(["teste-tag"])

    await app.inject({
      method: "PATCH",
      url: `/sinapses/${created.id}`,
      headers: auth,
      payload: { content: "## Notas\n\nMudou de emprego." },
    })
    const versions = (
      await app.inject({ method: "GET", url: `/sinapses/${created.id}/versions`, headers: auth })
    ).json<{ versions: { id: string; content: string; author: string }[] }>().versions
    expect(versions).toHaveLength(2)
    expect(versions[0]!.content).toContain("Mudou de emprego")
    expect(versions[0]!.author).toBe("user")

    // Restaurar a primeira gera uma terceira versão (nada se perde).
    const restored = await app.inject({
      method: "POST",
      url: `/sinapses/${created.id}/versions/${versions[1]!.id}/restore`,
      headers: auth,
    })
    expect(restored.json().content).toContain("Sobre Carreira")
    const after = await app.inject({
      method: "GET",
      url: `/sinapses/${created.id}/versions`,
      headers: auth,
    })
    expect(after.json().versions).toHaveLength(3)
  })

  it("desfazer a criação manda a sinapse para a lixeira", async () => {
    const created = await create("Temporária")
    const [version] = (
      await app.inject({ method: "GET", url: `/sinapses/${created.id}/versions`, headers: auth })
    ).json().versions
    const undo = await app.inject({
      method: "POST",
      url: `/sinapses/versions/${version.id}/undo`,
      headers: auth,
    })
    expect(undo.json()).toMatchObject({ deleted: true })
    expect(
      (await app.inject({ method: "GET", url: `/sinapses/${created.id}`, headers: auth }))
        .statusCode,
    ).toBe(404)
  })

  it("busca textual encontra pela palavra", async () => {
    await create("Receitas", "## Doces\n\nBolo de cenoura com chocolate.", "Receitas de família.")
    const response = await app.inject({ method: "GET", url: "/sinapses?q=cenoura", headers: auth })
    expect(response.json().sinapses.map((s: { title: string }) => s.title)).toContain("Receitas")
  })
})

describe("conexões, mesclar e dividir", () => {
  it("conecta em qualquer ordem sem duplicar e aparece no grafo", async () => {
    const a = await create("Filosofia")
    const b = await create("Estoicismo")
    for (const pair of [
      { a: a.id, b: b.id },
      { a: b.id, b: a.id },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/sinapses/links",
        headers: auth,
        payload: { ...pair, reason: "relacionadas" },
      })
      expect(response.statusCode).toBe(200)
    }
    const graph = (
      await app.inject({ method: "GET", url: "/sinapses/graph", headers: auth })
    ).json()
    expect(
      graph.edges.filter((edge: { source: string; target: string }) =>
        [edge.source, edge.target].includes(a.id),
      ),
    ).toHaveLength(1)
  })

  it("mesclar junta o conteúdo e arquiva a fonte", async () => {
    const target = await create("Saúde", "## Treino\n\nCorrida 3x por semana.")
    const source = await create("Exercícios", "## Academia\n\nMusculação às terças.")
    const merged = await app.inject({
      method: "POST",
      url: `/sinapses/${target.id}/merge`,
      headers: auth,
      payload: { sourceIds: [source.id] },
    })
    expect(merged.json().content).toContain("Musculação")
    const [archived] = await db.select().from(sinapses).where(eq(sinapses.id, source.id))
    expect(archived?.status).toBe("archived")
  })

  it("dividir cria uma sinapse nova conectada", async () => {
    const original = await create("Projetos", "## App\n\nPersonal AI\n\n## Jogo\n\nRPG de texto")
    const response = await app.inject({
      method: "POST",
      url: `/sinapses/${original.id}/split`,
      headers: auth,
      payload: {
        remainingContent: "## App\n\nPersonal AI",
        extracted: {
          title: "Jogo RPG",
          summary: "Ideia de jogo.",
          content: "RPG de texto",
          tags: [],
        },
      },
    })
    expect(response.statusCode).toBe(201)
    const detail = (
      await app.inject({ method: "GET", url: `/sinapses/${original.id}`, headers: auth })
    ).json()
    expect(detail.sinapse.content).not.toContain("RPG")
    expect(detail.links.map((link: { title: string }) => link.title)).toContain("Jogo RPG")
  })
})

describe("sinapse travada e sugestões (D21)", () => {
  it("aceitar a sugestão aplica a mudança", async () => {
    const locked = await create("Valores pessoais")
    await app.inject({
      method: "PATCH",
      url: `/sinapses/${locked.id}`,
      headers: auth,
      payload: { locked: true },
    })
    const [suggestion] = await db
      .insert(sinapseSuggestions)
      .values({
        sinapseId: locked.id,
        kind: "update",
        payload: { kind: "update", patch: { content: "## Novo\n\nHonestidade." } },
        reason: "teste",
      })
      .returning()
    const accept = await app.inject({
      method: "POST",
      url: `/sinapses/suggestions/${suggestion!.id}/accept`,
      headers: auth,
    })
    expect(accept.statusCode).toBe(200)
    const [row] = await db.select().from(sinapses).where(eq(sinapses.id, locked.id))
    expect(row?.content).toContain("Honestidade")
  })
})

describe("consolidação em background", () => {
  async function conversationWith(text: string, { idle = true } = {}) {
    const [conversation] = await db
      .insert(conversations)
      .values({ updatedAt: idle ? new Date(Date.now() - 3_600_000) : new Date() })
      .returning()
    const [user] = await db
      .insert(messages)
      .values({
        conversationId: conversation!.id,
        role: "user",
        content: [{ type: "text", text }],
        contentText: text,
      })
      .returning()
    await db
      .update(conversations)
      .set({ currentLeafMessageId: user!.id, updatedAt: conversation!.updatedAt })
      .where(eq(conversations.id, conversation!.id))
    return conversation!.id
  }

  it("cria sinapse nova a partir do trecho da conversa", async () => {
    const id = await conversationWith("Decidi que vou aprender piano no ano que vem.")
    fake.parsed = [
      {
        items: [
          {
            action: "create",
            sinapseId: "",
            title: "Música",
            emoji: "🎹",
            summary: "Planos musicais do usuário.",
            sectionTitle: "",
            content: "## Planos\n\n- Aprender piano no ano que vem.",
            tags: ["musica"],
            reason: "Decisão de aprender piano",
          },
        ],
        links: [],
      },
    ]
    const result = await consolidateConversation(id)
    expect(result.applied).toBe(1)
    const [created] = await db.select().from(sinapses).where(eq(sinapses.title, "Música"))
    expect(created?.content).toContain("piano")
  })

  it("tema quase igual a um existente vira atualização, não duplicata", async () => {
    await create(
      "Culinária",
      "## Pratos\n\nLasanha.",
      "Receitas e pratos que o usuário gosta de cozinhar.",
    )
    const id = await conversationWith("Aprendi a fazer risoto.")
    fake.parsed = [
      {
        items: [
          {
            action: "create",
            sinapseId: "",
            title: "Culinária",
            emoji: "🍳",
            summary: "Receitas e pratos que o usuário gosta de cozinhar.",
            sectionTitle: "Risoto",
            content: "Aprendeu a fazer risoto.",
            tags: [],
            reason: "novo prato",
          },
        ],
        links: [],
      },
    ]
    await consolidateConversation(id)
    const rows = await db.select().from(sinapses).where(eq(sinapses.title, "Culinária"))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toContain("risoto")
  })

  it("conversa ainda ativa é reagendada em vez de consolidada", async () => {
    const id = await conversationWith("Mensagem recente", { idle: false })
    const result = await consolidateConversation(id)
    expect(result).toMatchObject({ rescheduled: true })
    expect(enqueuedJobs.at(-1)?.name).toBe("sinapses.consolidate")
  })
})

describe("applySectionOperation", () => {
  const doc = "## A\n\num\n\n## B\n\ndois\n\n## C\n\ntrês"
  it("troca só a seção pedida", () => {
    expect(applySectionOperation(doc, "replace_section", "B", "novo")).toBe(
      "## A\n\num\n\n## B\n\nnovo\n\n## C\n\ntrês",
    )
  })
  it("acrescenta seção nova quando não existe", () => {
    expect(applySectionOperation(doc, "replace_section", "D", "quatro")).toContain("## D\n\nquatro")
    expect(
      applySectionOperation(doc, "append_section", "E", "cinco").endsWith("## E\n\ncinco"),
    ).toBe(true)
  })
})
