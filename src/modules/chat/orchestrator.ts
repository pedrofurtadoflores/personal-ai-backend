import { eq } from "drizzle-orm"
import type {
  ResponseInputItem,
  ResponseOutputItem,
  Tool,
} from "openai/resources/responses/responses"
import { db } from "../../db/client.js"
import { messages } from "../../db/schema.js"
import { enqueue } from "../../lib/jobs.js"
import { openai } from "../../lib/openai.js"
import {
  addUsage,
  emptyUsage,
  fromResponsesUsage,
  recordUsage,
  tokenCost,
} from "../../lib/pricing.js"
import {
  branchTo,
  listMessages,
  touchConversation,
  type Conversation,
  type Message,
} from "../conversations/service.js"
import { saveGeneratedImage, fileUrl } from "../files/service.js"
import { getSettings, type AppSettings } from "../settings/service.js"
import { buildInput, buildInstructions, retrieveContext } from "./context.js"
import { partsToText, type MessagePart } from "./parts.js"
import { runSinapseTool, sinapseTools } from "./tools.js"

/** Máximo de rodadas de tools numa resposta (evita loops). */
const MAX_ROUNDS = 6

/** Estimativa por imagem gerada (a resposta não informa os tokens da tool de imagem). */
const IMAGE_COST_ESTIMATE: Record<AppSettings["imageQuality"], number> = {
  low: 0.012,
  medium: 0.045,
  high: 0.18,
  auto: 0.045,
}

export type ReplyOptions = {
  model?: string | null
  reasoningEffort?: string | null
  webSearch?: boolean
  imageGeneration?: boolean
}

export type Emit = (event: string, data: unknown) => void

const isAbort = (error: unknown, signal: AbortSignal) =>
  signal.aborted ||
  (error instanceof Error && (error.name === "AbortError" || error.name === "APIUserAbortError"))

/**
 * Gera a resposta do assistente para `userMessage`, em streaming, e grava tudo na
 * mensagem `assistantMessageId` (histórico completo, D27). Parar no meio salva o parcial.
 */
export async function generateReply(params: {
  conversation: Conversation
  userMessage: Message
  assistantMessageId: string
  options: ReplyOptions
  emit: Emit
  signal: AbortSignal
}) {
  const { conversation, userMessage, assistantMessageId, emit, signal } = params
  const settings = await getSettings()
  const convSettings = conversation.settings as ReplyOptions
  const model = params.options.model || conversation.model || settings.chatDefaultModel
  const effort =
    params.options.reasoningEffort ?? convSettings.reasoningEffort ?? settings.chatReasoningEffort
  const webSearch = params.options.webSearch ?? convSettings.webSearch ?? false
  const imageGeneration = params.options.imageGeneration ?? convSettings.imageGeneration ?? false

  const parts: MessagePart[] = []
  const sources = new Map<string, string>()
  const usage = emptyUsage()
  let text = ""
  let webSearchCalls = 0
  let imagesGenerated = 0
  let external = false

  const onPart = (part: MessagePart) => {
    parts.push(part)
    emit("part", part)
  }

  try {
    const all = await listMessages(conversation.id)
    const branch = branchTo(all, userMessage.id)
    const [instructions, built] = await Promise.all([
      buildInstructions(conversation, settings),
      buildInput(branch),
    ])
    const input: ResponseInputItem[] = built.input
    const userHasFiles = (userMessage.content as MessagePart[]).some((part) => part.type === "file")
    external = userHasFiles || built.hasAttachments

    const rag = await retrieveContext(conversation, userMessage.contentText ?? "")
    if (rag.text) {
      input.splice(Math.max(input.length - 1, 0), 0, { role: "developer", content: rag.text })
      if (rag.usedFiles) external = true
    }
    if (rag.part) onPart(rag.part)

    const tools: Tool[] = []
    if (!conversation.anonymous) tools.push(...sinapseTools)
    if (webSearch) tools.push({ type: "web_search" })
    if (imageGeneration) {
      // WebP: bem mais leve que PNG para a galeria e o chat (2,4 MB → ~200 KB).
      tools.push({
        type: "image_generation",
        model: settings.imageModel,
        quality: settings.imageQuality,
        output_format: "webp",
        output_compression: 85,
      })
    }

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const stream = await openai().responses.create(
        {
          model,
          instructions,
          input,
          ...(tools.length ? { tools } : {}),
          ...(effort && effort !== "auto" ? { reasoning: { effort: effort as "low" } } : {}),
          // Histórico é nosso (store: false); o raciocínio volta criptografado entre rodadas de tools.
          store: false,
          include: ["reasoning.encrypted_content"],
          stream: true,
        },
        { signal },
      )

      let output: ResponseOutputItem[] = []
      let roundText = ""
      for await (const event of stream) {
        switch (event.type) {
          case "response.output_text.delta":
            if (!roundText && text) {
              text += "\n\n"
              emit("delta", { text: "\n\n" })
            }
            roundText += event.delta
            text += event.delta
            emit("delta", { text: event.delta })
            break
          case "response.web_search_call.searching":
            emit("status", { tool: "web_search", state: "searching" })
            break
          case "response.image_generation_call.generating":
            emit("status", { tool: "image_generation", state: "generating" })
            break
          case "response.output_item.done": {
            const item = event.item
            if (item.type === "web_search_call") {
              webSearchCalls += 1
              external = true
              const action = item.action as { query?: string; queries?: string[] }
              const query = action.query ?? action.queries?.[0] ?? null
              onPart({ type: "tool", name: "web_search", detail: query })
            }
            if (item.type === "image_generation_call" && item.result) {
              const file = await saveGeneratedImage({
                base64: item.result,
                format: item.output_format ?? "png",
                prompt: item.revised_prompt ?? null,
                messageId: assistantMessageId,
                conversationId: conversation.id,
              })
              imagesGenerated += 1
              onPart({ type: "image", fileId: file.id, prompt: item.revised_prompt ?? null })
              emit("image", { fileId: file.id, url: await fileUrl(file) })
            }
            if (item.type === "message") {
              for (const content of item.content) {
                if (content.type !== "output_text") continue
                for (const annotation of content.annotations) {
                  if (annotation.type === "url_citation")
                    sources.set(annotation.url, annotation.title)
                }
              }
            }
            break
          }
          case "response.completed":
            output = event.response.output
            addUsage(usage, fromResponsesUsage(event.response.usage))
            break
          case "response.failed":
            throw new Error(
              event.response.error?.message ?? "A OpenAI não conseguiu gerar a resposta.",
            )
          case "response.incomplete":
            output = event.response.output
            addUsage(usage, fromResponsesUsage(event.response.usage))
            break
          case "error":
            throw new Error(event.message)
        }
      }

      const calls = output.filter((item) => item.type === "function_call")
      if (!calls.length) break

      // Devolve tudo o que o modelo produziu (inclusive o raciocínio criptografado) + os resultados.
      input.push(...(output as ResponseInputItem[]))
      for (const call of calls) {
        emit("status", { tool: call.name, state: "running" })
        const result = await runSinapseTool(call.name, call.arguments, {
          conversationId: conversation.id,
          messageId: assistantMessageId,
          external: () => external,
          onPart,
        })
        input.push({ type: "function_call_output", call_id: call.call_id, output: result.output })
      }
    }

    return await finish("completed")
  } catch (error) {
    if (isAbort(error, signal)) return await finish("stopped")
    const message = error instanceof Error ? error.message : "Erro desconhecido"
    emit("error", { error: "generation_failed", message })
    return await finish("error", message)
  }

  async function finish(status: "completed" | "stopped" | "error", errorMessage?: string) {
    if (sources.size) {
      parts.push({ type: "sources", items: [...sources].map(([url, title]) => ({ url, title })) })
    }
    const content: MessagePart[] = [...(text ? [{ type: "text" as const, text }] : []), ...parts]
    const textCost = await tokenCost(model, usage)
    const searchCost = webSearchCalls * settings.webSearchUsdPerCall
    const imageCost = imagesGenerated * IMAGE_COST_ESTIMATE[settings.imageQuality]

    const [saved] = await db
      .update(messages)
      .set({
        content,
        contentText: partsToText(content) || null,
        model,
        params: { reasoningEffort: effort, webSearch, imageGeneration },
        status,
        error: errorMessage ?? null,
        tokensIn: usage.input,
        tokensCached: usage.cached,
        tokensOut: usage.output,
        tokensReasoning: usage.reasoning,
        costUsd: textCost + searchCost + imageCost,
        completedAt: new Date(),
      })
      .where(eq(messages.id, assistantMessageId))
      .returning()

    if (usage.input || usage.output) {
      await recordUsage({
        source: "chat",
        model,
        usage,
        costUsd: textCost,
        messageId: assistantMessageId,
      })
    }
    if (webSearchCalls) {
      await recordUsage({
        source: "chat",
        model: "web_search",
        units: { calls: webSearchCalls },
        costUsd: searchCost,
        messageId: assistantMessageId,
      })
    }
    if (imagesGenerated) {
      await recordUsage({
        source: "image",
        model: settings.imageModel,
        units: { images: imagesGenerated, estimated: 1 },
        costUsd: imageCost,
        messageId: assistantMessageId,
      })
    }

    await touchConversation(conversation.id)
    if (status !== "error") {
      if (!conversation.title) {
        await enqueue(
          "conversation.title",
          { conversationId: conversation.id },
          { singleton: true, key: `title:${conversation.id}` },
        )
      }
      await enqueue("messages.embed", { messageIds: [userMessage.id, assistantMessageId] })
      if (!conversation.anonymous) {
        await enqueue(
          "sinapses.consolidate",
          { conversationId: conversation.id },
          {
            delaySeconds: settings.sinapsesConsolidationDelaySeconds,
            key: `consolidate:${conversation.id}`,
          },
        )
      }
    }
    return saved!
  }
}
