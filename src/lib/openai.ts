import OpenAI from "openai"
import { env } from "../config/env.js"
import { HttpError } from "./http.js"

let client: OpenAI | undefined

/** Cliente único da OpenAI. Rotas que dependem dele respondem 503 se a chave não estiver configurada. */
export function openai(): OpenAI {
  if (client) return client
  if (!env.OPENAI_API_KEY) {
    throw new HttpError(503, "openai_not_configured", "OPENAI_API_KEY não está configurada.")
  }
  client = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 2, timeout: 10 * 60_000 })
  return client
}

/** Só para testes: troca o cliente por um falso. */
export function setOpenAIClient(fake: OpenAI | undefined) {
  client = fake
}
