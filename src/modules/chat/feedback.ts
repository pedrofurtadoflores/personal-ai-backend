/**
 * Feedback nas respostas (D77). Um 👍/👎 com comentário vira, se for o caso, uma preferência
 * durável na sinapse fixada "Preferências de resposta". A escrita gera versão (dá para
 * desfazer) e, se a sinapse estiver travada, vira sugestão.
 */
import { and, eq, isNull } from "drizzle-orm"
import { zodTextFormat } from "openai/helpers/zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { messages, sinapses } from "../../db/schema.js"
import { truncate } from "../../lib/chunk.js"
import { registerJob } from "../../lib/jobs.js"
import { openai } from "../../lib/openai.js"
import { fromResponsesUsage, recordUsage } from "../../lib/pricing.js"
import { getConversation } from "../conversations/service.js"
import { getInternal, getSettings, internalKeys, setInternal } from "../settings/service.js"
import { createSinapse, getSinapse, suggest, updateSinapse } from "../sinapses/service.js"
import { partsToText, type MessagePart } from "./parts.js"

const PREFS_TITLE = "Preferências de resposta"

/** Garante a sinapse fixada onde as preferências aprendidas ficam. */
export async function ensureResponsePrefs() {
  const existingId = await getInternal<string>(internalKeys.responsePrefsSinapseId)
  if (existingId) {
    const [row] = await db
      .select({ id: sinapses.id })
      .from(sinapses)
      .where(and(eq(sinapses.id, existingId), isNull(sinapses.deletedAt)))
    if (row) return row.id
  }
  const { sinapse } = await createSinapse(
    {
      title: PREFS_TITLE,
      emoji: "🎯",
      summary: "Como o usuário prefere receber as respostas, aprendido com as avaliações dele.",
      content: "## Como responder\n",
      tags: ["preferencias"],
    },
    { author: "ai", reason: "Criada pelo primeiro feedback" },
  )
  await db.update(sinapses).set({ pinned: true }).where(eq(sinapses.id, sinapse.id))
  await setInternal(internalKeys.responsePrefsSinapseId, sinapse.id)
  return sinapse.id
}

const preferenceSchema = z.object({
  /** "" quando o comentário não revela uma preferência durável. */
  preference: z.string(),
})

export async function learnFromFeedback(messageId: string) {
  const [message] = await db.select().from(messages).where(eq(messages.id, messageId))
  const note = message?.feedbackNote?.trim()
  if (!message || !message.rating || !note) return
  const conversation = await getConversation(message.conversationId).catch(() => null)
  if (!conversation || conversation.anonymous) return
  const [question] = message.parentId
    ? await db.select().from(messages).where(eq(messages.id, message.parentId))
    : []

  const prefsId = await ensureResponsePrefs()
  const prefs = await getSinapse(prefsId)
  const { backgroundModel } = await getSettings()
  const response = await openai().responses.parse({
    model: backgroundModel,
    store: false,
    instructions:
      "O usuário avaliou uma resposta do assistente pessoal dele. A partir do comentário, extraia no máximo UMA " +
      "preferência durável sobre COMO ele quer receber respostas (formato, tamanho, tom, nível de detalhe, idioma, " +
      "estilo de código, uso de exemplos...). Se o comentário for só sobre aquele caso (um erro pontual, um fato " +
      "específico) ou já estiver nas preferências registradas, devolva preference vazia. Escreva em pt-BR, em " +
      "terceira pessoa, numa frase curta e acionável.",
    input:
      `## Preferências já registradas\n\n${prefs.content}\n\n` +
      `## Pergunta\n\n${truncate(question?.contentText ?? "", 3_000)}\n\n` +
      `## Resposta avaliada (${message.rating === "up" ? "👍 gostou" : "👎 não gostou"})\n\n` +
      `${truncate(partsToText(message.content as MessagePart[]), 4_000)}\n\n` +
      `## Comentário do usuário\n\n${note}`,
    text: { format: zodTextFormat(preferenceSchema, "feedback") },
  })
  await recordUsage({
    source: "background",
    model: backgroundModel,
    usage: fromResponsesUsage(response.usage),
  })
  const preference = response.output_parsed?.preference.trim().replace(/^-\s*/, "")
  if (!preference) return
  if (prefs.content.toLowerCase().includes(preference.toLowerCase())) return

  const content = `${prefs.content.trim()}\n- ${preference}`
  const reason = `Aprendido com o feedback ${message.rating === "up" ? "👍" : "👎"}: "${truncate(note, 200)}"`
  if (prefs.locked) {
    await suggest(prefs.id, { kind: "update", patch: { content } }, reason, messageId)
    return
  }
  await updateSinapse(
    prefs.id,
    { content },
    { author: "ai", reason, sourceMessageId: messageId, conversationId: conversation.id },
  )
}

registerJob<{ messageId: string }>("feedback.learn", ({ messageId }) =>
  learnFromFeedback(messageId),
)
