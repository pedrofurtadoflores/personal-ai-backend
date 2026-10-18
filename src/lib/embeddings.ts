import { EMBEDDING_DIMENSIONS } from "../db/schema.js"
import { getSettings } from "../modules/settings/service.js"
import { openai } from "./openai.js"
import { recordUsage } from "./pricing.js"

const BATCH = 96
const MAX_CHARS = 24_000 // ~6k tokens, abaixo do limite de 8k por item

export type Embedded = { model: string; vectors: number[][] }

/** Gera embeddings (sempre com 1536 dimensões, D24) e registra o custo. */
export async function embed(texts: string[]): Promise<Embedded> {
  const { embeddingModel: model } = await getSettings()
  const vectors: number[][] = []
  for (let start = 0; start < texts.length; start += BATCH) {
    const input = texts.slice(start, start + BATCH).map((text) => text.slice(0, MAX_CHARS) || " ")
    const response = await openai().embeddings.create({
      model,
      input,
      dimensions: EMBEDDING_DIMENSIONS,
    })
    vectors.push(...response.data.map((item) => item.embedding))
    await recordUsage({
      source: "embedding",
      model,
      usage: { input: response.usage.prompt_tokens, cached: 0, output: 0, reasoning: 0 },
    })
  }
  return { model, vectors }
}

export async function embedOne(text: string) {
  const { model, vectors } = await embed([text])
  return { model, vector: vectors[0]! }
}
