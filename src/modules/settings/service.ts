import { inArray } from "drizzle-orm"
import { z } from "zod"
import { db } from "../../db/client.js"
import { settings } from "../../db/schema.js"

/**
 * Configurações do app (D24). Tudo tem padrão e é alterável no painel.
 * Cada chave é uma linha na tabela `settings`; o objeto completo é montado aqui.
 */
export const reasoningEfforts = [
  "auto",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const
export const voices = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const

export const appSettingsSchema = z.object({
  chatDefaultModel: z.string().min(1).default("gpt-6-sol"),
  chatReasoningEffort: z.enum(reasoningEfforts).default("auto"),
  /** Instruções personalizadas globais (tipo "Custom Instructions"). */
  customInstructions: z.string().max(8_000).default(""),
  backgroundModel: z.string().min(1).default("gpt-6-luna"),
  /** Só modelos v3 (aceitam `dimensions`, mantendo os vetores em 1536). */
  embeddingModel: z
    .enum(["text-embedding-3-small", "text-embedding-3-large"])
    .default("text-embedding-3-small"),
  imageModel: z.string().min(1).default("gpt-image-2"),
  imageQuality: z.enum(["low", "medium", "high", "auto"]).default("medium"),
  transcriptionModel: z.string().min(1).default("gpt-4o-mini-transcribe"),
  speechModel: z.string().min(1).default("gpt-4o-mini-tts"),
  speechVoice: z.enum(voices).default("alloy"),
  realtimeModel: z.string().min(1).default("gpt-realtime-2.1-mini"),
  realtimeVoice: z.enum(voices).default("alloy"),
  /** D26: quão agressiva é a criação automática de sinapses. */
  sinapsesAggressiveness: z.enum(["conservative", "balanced", "liberal"]).default("balanced"),
  /** Espera depois da última mensagem antes de consolidar a conversa. */
  sinapsesConsolidationDelaySeconds: z.number().int().min(30).max(3_600).default(180),
  /** D23: só alerta, sem bloqueio. 0 = sem limite. */
  monthlyLimitUsd: z.number().min(0).default(50),
  alertThreshold: z.number().min(0.1).max(1).default(0.8),
  /** Preço por chamada da tool de busca web (página de preços: US$ 10 / 1k chamadas). */
  webSearchUsdPerCall: z.number().min(0).default(0.01),
  /** Preço por container do interpretador de código (página de preços: US$ 0,03 por sessão). */
  codeInterpreterUsdPerContainer: z.number().min(0).default(0.03),
  /**
   * D67: teto de tokens do histórico enviado a cada resposta. Acima disso, o começo da conversa
   * vira um resumo. Também respeita a janela do modelo, quando o catálogo a conhece.
   */
  contextBudgetTokens: z.number().int().min(8_000).max(1_000_000).default(60_000),
  /** D76: prompts salvos, usados com "/" no composer. */
  savedPrompts: z
    .array(
      z.object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(40)
          .regex(/^[\p{L}\p{N}_-]+$/u),
        text: z.string().trim().min(1).max(4_000),
      }),
    )
    .max(50)
    .default([
      {
        name: "resumir",
        text: "Resuma o texto abaixo em tópicos curtos, sem perder números e nomes:",
      },
      { name: "traduzir", text: "Traduza o texto abaixo para o inglês, mantendo o tom:" },
      {
        name: "revisar",
        text: "Revise o texto abaixo: corrija gramática e clareza e explique as mudanças principais.",
      },
      { name: "explicar", text: "Explique de forma simples, com um exemplo concreto:" },
    ]),
})

export type AppSettings = z.infer<typeof appSettingsSchema>
export const appSettingsPatch = appSettingsSchema.partial()

/** Chaves internas (não editáveis pelo painel). */
export const internalKeys = {
  sessionVersion: "auth.session_version",
  aboutMeSinapseId: "sinapses.about_me_id",
  responsePrefsSinapseId: "sinapses.response_prefs_id",
  chatSuggestions: "chat.suggestions",
  modelsSyncedAt: "models.synced_at",
} as const

const PREFIX = "app."
let cache: { at: number; value: AppSettings } | undefined
const CACHE_MS = 30_000

export async function getSettings(): Promise<AppSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  const keys = Object.keys(appSettingsSchema.shape).map((key) => PREFIX + key)
  const rows = await db.select().from(settings).where(inArray(settings.key, keys))
  const raw = Object.fromEntries(rows.map((row) => [row.key.slice(PREFIX.length), row.value]))
  // Valores salvos inválidos (ex.: enum que mudou) caem no padrão em vez de quebrar o app.
  const value = appSettingsSchema.parse(
    Object.fromEntries(
      Object.entries(raw).filter(([key, v]) => {
        const field = appSettingsSchema.shape[key as keyof AppSettings]
        return field?.safeParse(v).success ?? false
      }),
    ),
  )
  cache = { at: Date.now(), value }
  return value
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const entries = Object.entries(appSettingsPatch.parse(patch)).filter(([, v]) => v !== undefined)
  for (const [key, value] of entries) {
    await db
      .insert(settings)
      .values({ key: PREFIX + key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
  }
  cache = undefined
  return getSettings()
}

export async function getInternal<T>(key: string): Promise<T | undefined> {
  const [row] = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [key]))
  return row?.value as T | undefined
}

export async function setInternal(key: string, value: unknown) {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
}

export function clearSettingsCache() {
  cache = undefined
}
