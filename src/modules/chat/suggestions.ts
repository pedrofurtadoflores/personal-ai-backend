/**
 * Sugestões da tela inicial (D72): saem da memória (índice de sinapses) e das conversas
 * recentes, geradas pelo modelo de background e guardadas por algumas horas.
 */
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm"
import { zodTextFormat } from "openai/helpers/zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { conversations } from "../../db/schema.js"
import { openai } from "../../lib/openai.js"
import { fromResponsesUsage, recordUsage } from "../../lib/pricing.js"
import { getInternal, getSettings, internalKeys, setInternal } from "../settings/service.js"
import { sinapseIndex } from "../sinapses/service.js"

export const FALLBACK_SUGGESTIONS = [
  "O que você já sabe sobre mim?",
  "Me ajude a organizar minhas ideias de projeto",
  "Resuma um artigo para mim",
  "Crie um plano de estudos",
]

const TTL_MS = 6 * 60 * 60 * 1000
const COUNT = 4

type Cached = { at: number; items: string[] }
let inFlight: Promise<{ suggestions: string[]; personalized: boolean }> | null = null

const schema = z.object({ suggestions: z.array(z.string()) })

async function generate() {
  const [index, recent] = await Promise.all([
    sinapseIndex(40),
    db
      .select({ title: conversations.title })
      .from(conversations)
      .where(
        and(
          isNull(conversations.deletedAt),
          eq(conversations.anonymous, false),
          isNotNull(conversations.title),
        ),
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(12),
  ])
  // Só "Sobre mim" e nada de conversa: ainda não há o que personalizar.
  if (index.length <= 1 && !recent.length) {
    return { suggestions: FALLBACK_SUGGESTIONS, personalized: false }
  }

  const { backgroundModel } = await getSettings()
  const response = await openai().responses.parse({
    model: backgroundModel,
    store: false,
    instructions:
      `Sugira ${COUNT} mensagens curtas (até 60 caracteres cada) que o usuário poderia mandar agora para o ` +
      "assistente pessoal dele, com base nos temas da memória e nas conversas recentes: continuar um projeto, " +
      "retomar algo pendente, aprofundar um interesse, revisar uma decisão. Escreva como o próprio usuário " +
      "falaria, em pt-BR, na primeira pessoa. Varie os temas.",
    input:
      `## Memória\n\n${index.map((item) => `- ${item.title}: ${item.summary}`).join("\n")}\n\n` +
      `## Conversas recentes\n\n${recent.map((row) => `- ${row.title}`).join("\n") || "(nenhuma)"}`,
    text: { format: zodTextFormat(schema, "suggestions") },
  })
  await recordUsage({
    source: "background",
    model: backgroundModel,
    usage: fromResponsesUsage(response.usage),
  })
  const items = (response.output_parsed?.suggestions ?? [])
    .map((item) => item.trim().replace(/^["“]|["”]$/g, ""))
    .filter((item) => item && item.length <= 120)
    .slice(0, COUNT)
  if (!items.length) return { suggestions: FALLBACK_SUGGESTIONS, personalized: false }
  await setInternal(internalKeys.chatSuggestions, { at: Date.now(), items } satisfies Cached)
  return { suggestions: items, personalized: true }
}

export async function homeSuggestions() {
  const cached = await getInternal<Cached>(internalKeys.chatSuggestions)
  if (cached && Date.now() - cached.at < TTL_MS && cached.items.length) {
    return { suggestions: cached.items, personalized: true }
  }
  // Várias abas abrindo juntas geram uma chamada só.
  inFlight ??= generate()
    .catch(() => ({ suggestions: FALLBACK_SUGGESTIONS, personalized: false }))
    .finally(() => {
      inFlight = null
    })
  return inFlight
}
