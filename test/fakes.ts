/**
 * OpenAI e R2 falsos para os testes: nada sai para a rede e nada é cobrado.
 * Os embeddings falsos usam hashing de palavras, então textos parecidos dão vetores parecidos.
 */
import type OpenAI from "openai"
import { sql } from "drizzle-orm"
import { db } from "../src/db/client.js"
import { EMBEDDING_DIMENSIONS } from "../src/db/schema.js"
import type { Storage } from "../src/lib/r2.js"

export function fakeVector(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  for (const word of text
    .toLowerCase()
    .normalize("NFKD")
    .match(/[a-z0-9]{3,}/g) ?? []) {
    let hash = 0
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    vector[hash % EMBEDDING_DIMENSIONS]! += 1
  }
  const norm = Math.hypot(...vector) || 1
  return vector.map((value) => value / norm)
}

type StreamEvent = Record<string, unknown> & { type: string }

/** Uma "rodada" da Responses API: eventos que o stream vai emitir. */
export type ScriptedRound = StreamEvent[]

export const usage = (input = 100, output = 20, cached = 0) => ({
  input_tokens: input,
  input_tokens_details: { cached_tokens: cached },
  output_tokens: output,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: input + output,
})

/** Rodada simples: texto em pedaços e `response.completed`. */
export function textRound(text: string, extraOutput: unknown[] = []): ScriptedRound {
  const chunks = text.match(/.{1,8}/gs) ?? []
  return [
    ...chunks.map((delta) => ({ type: "response.output_text.delta", delta })),
    {
      type: "response.completed",
      response: {
        output: [
          ...extraOutput,
          { type: "message", content: [{ type: "output_text", text, annotations: [] }] },
        ],
        usage: usage(),
      },
    },
  ]
}

/** Rodada em que o modelo chama uma função. */
export function functionCallRound(
  name: string,
  args: unknown,
  callId = `call_${name}`,
): ScriptedRound {
  const item = {
    type: "function_call",
    name,
    arguments: JSON.stringify(args),
    call_id: callId,
    id: `fc_${callId}`,
  }
  return [
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        output: [{ type: "reasoning", id: "rs_1", summary: [] }, item],
        usage: usage(200, 30),
      },
    },
  ]
}

export function webSearchItem(query: string) {
  return {
    type: "web_search_call",
    id: "ws_1",
    status: "completed",
    action: { type: "search", query },
  }
}

export class FakeOpenAI {
  rounds: ScriptedRound[] = []
  parsed: unknown[] = []
  /** Textos das chamadas sem streaming (título, resumo de contexto). */
  texts: string[] = []
  requests: Record<string, unknown>[] = []
  /** Erro a lançar na próxima chamada com streaming (ex.: parâmetro recusado). */
  failNext: Error | null = null
  containerCalls: { op: string; args: unknown[] }[] = []
  containerStatus = "running"
  modelIds = [
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-novo-x",
    "gpt-6-sol-2026-01-01",
    "text-embedding-3-small",
    "whisper-1",
    "sora-2",
  ]

  responses = {
    create: async (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      this.requests.push(params)
      if (!params.stream) {
        return { output_text: this.texts.shift() ?? "Título de teste", usage: usage(50, 5) }
      }
      if (this.failNext) {
        const error = this.failNext
        this.failNext = null
        throw error
      }
      const round = this.rounds.shift() ?? textRound("ok")
      const signal = options?.signal
      return (async function* () {
        for (const event of round) {
          if (signal?.aborted) {
            const error = new Error("aborted")
            error.name = "APIUserAbortError"
            throw error
          }
          await new Promise((resolve) => setTimeout(resolve, 1))
          yield event
        }
      })()
    },
    parse: async (params: Record<string, unknown>) => {
      this.requests.push(params)
      return { output_parsed: this.parsed.shift() ?? null, usage: usage(300, 60) }
    },
  }

  embeddings = {
    create: async ({ input }: { input: string[] }) => ({
      data: input.map((text) => ({ embedding: fakeVector(text) })),
      usage: { prompt_tokens: Math.ceil(input.join(" ").length / 4) },
    }),
  }

  // `models.list()` é um iterável assíncrono na SDK.
  models = {
    list: () => {
      const ids = this.modelIds
      return (async function* () {
        for (const id of ids) yield { id, created: 1_700_000_000 }
      })()
    },
  }

  audio = {
    transcriptions: {
      create: async () => ({ text: " texto ditado ", usage: { type: "duration", seconds: 3 } }),
    },
    speech: { create: async () => new Response(Buffer.from("mp3-falso")) },
  }

  containers = {
    create: async (body: unknown) => {
      this.containerCalls.push({ op: "create", args: [body] })
      return { id: `cntr_${this.containerCalls.length}`, status: "running" }
    },
    retrieve: async (id: string) => {
      this.containerCalls.push({ op: "retrieve", args: [id] })
      return { id, status: this.containerStatus }
    },
    files: {
      create: async (containerId: string, body: { file: { name: string } }) => {
        this.containerCalls.push({ op: "upload", args: [containerId, body.file.name] })
        return { id: "cfile_upload" }
      },
      content: {
        retrieve: async (fileId: string, params: { container_id: string }) => {
          this.containerCalls.push({ op: "download", args: [fileId, params.container_id] })
          return new Response(Buffer.from("a,b\n1,2\n"))
        },
      },
    },
  }

  realtime = {
    clientSecrets: {
      create: async () => ({ value: "ek_teste", expires_at: Math.floor(Date.now() / 1000) + 600 }),
    },
  }

  asClient() {
    return this as unknown as OpenAI
  }
}

export class FakeStorage implements Storage {
  objects = new Map<string, Buffer>()
  async presignPut(key: string) {
    return `https://r2.test/${key}?put`
  }
  async presignGet(key: string) {
    return `https://r2.test/${key}?get`
  }
  async head(key: string) {
    const object = this.objects.get(key)
    return object ? { size: object.length } : null
  }
  async get(key: string) {
    return this.objects.get(key) ?? Buffer.alloc(0)
  }
  async put(key: string, body: Buffer) {
    this.objects.set(key, body)
  }
  async delete(key: string) {
    this.objects.delete(key)
  }
  async list(prefix: string) {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key }))
  }
  publicOrigin() {
    return "https://r2.test"
  }
}

/** Limpa os dados (mantém o schema) para cada arquivo de teste começar do zero. */
export async function resetData() {
  await db.execute(sql`
    truncate table conversation_summaries, usage_events, generated_images, message_files, file_chunks, sinapse_suggestions,
      sinapse_sources, sinapse_links, sinapse_versions, sinapse_chunks, sinapses, tool_calls,
      message_embeddings, messages, conversations, folders, files, model_catalog, backups, login_throttle,
      fin_changes, fin_splits, fin_transactions, fin_rule_suggestions, fin_rules, fin_recurring, fin_import_batches,
      fin_debt_payments, fin_debts, fin_pending, fin_invoices, fin_asset_valuations, fin_assets, fin_categories, fin_accounts
    restart identity cascade
  `)
  await db.execute(
    sql`delete from settings where key like 'app.%' or key like 'sinapses.%' or key like 'models.%' or key like 'chat.%' or key like 'finance.%'`,
  )
}

/** Lê uma resposta SSE (payload completo do inject) como lista de eventos. */
export function parseSse(payload: string) {
  return payload
    .split("\n\n")
    .filter((block) => block.startsWith("event:"))
    .map((block) => ({
      event: block.match(/^event: (.*)$/m)![1]!,
      data: JSON.parse(block.match(/^data: (.*)$/m)![1]!) as Record<string, unknown>,
    }))
}
