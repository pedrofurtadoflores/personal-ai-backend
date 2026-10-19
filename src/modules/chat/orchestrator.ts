import { eq } from "drizzle-orm"
import type {
  ResponseIncludable,
  ResponseInputItem,
  ResponseOutputItem,
  Tool,
} from "openai/resources/responses/responses"
import { db } from "../../db/client.js"
import { messages } from "../../db/schema.js"
import { truncate } from "../../lib/chunk.js"
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
import { fileUrl, saveGeneratedFile, saveGeneratedImage } from "../files/service.js"
import { getSettings, type AppSettings } from "../settings/service.js"
import { downloadContainerFile, mimeFor, prepareContainer } from "./code-interpreter.js"
import {
  compactBranch,
  contextBudget,
  estimateTokens,
  messageTokens,
  needsCompaction,
  type ContextParams,
} from "./compaction.js"
import {
  branchFileIds,
  buildInput,
  buildInstructions,
  codeInterpreterFiles,
  folderOf,
  retrieveContext,
} from "./context.js"
import { partsToText, type MessagePart } from "./parts.js"
import type { Emit } from "./runs.js"
import { fetchUrlTool, runTool, sinapseTools } from "./tools.js"

export type { Emit }

/** Máximo de rodadas de tools numa resposta (evita loops). */
const MAX_ROUNDS = 8

/** Estimativa por imagem gerada (a resposta não informa os tokens da tool de imagem). */
const IMAGE_COST_ESTIMATE: Record<AppSettings["imageQuality"], number> = {
  low: 0.012,
  medium: 0.045,
  high: 0.18,
  auto: 0.045,
}

const incompleteText: Record<string, string> = {
  max_output_tokens: "A resposta foi cortada por atingir o limite de tamanho.",
  content_filter: "A resposta foi interrompida pelo filtro de conteúdo.",
}

export type ReplyOptions = {
  model?: string | null
  reasoningEffort?: string | null
  webSearch?: boolean
  imageGeneration?: boolean
  codeInterpreter?: boolean
  /** D71: só vai para a OpenAI se o modelo aceitar (senão é ignorada e lembrada). */
  temperature?: number | null
}

/** Modelos que recusaram `temperature` (os de raciocínio): não manda mais para eles. */
const noTemperature = new Set<string>()

const isAbort = (error: unknown, signal: AbortSignal) =>
  signal.aborted ||
  (error instanceof Error && (error.name === "AbortError" || error.name === "APIUserAbortError"))

const isTemperatureError = (error: unknown) =>
  (error as { status?: number }).status === 400 &&
  /temperature/i.test(error instanceof Error ? error.message : "")

/** Só URLs da própria OpenAI ou data: (saída de imagem do interpretador de código). */
async function downloadCodeImage(url: string) {
  if (url.startsWith("data:image/")) {
    const [, format, base64] = url.match(/^data:image\/(\w+);base64,(.*)$/s) ?? []
    return format && base64 ? { format, base64 } : null
  }
  const parsed = new URL(url)
  if (
    parsed.protocol !== "https:" ||
    !/(^|\.)(openai\.com|oaiusercontent\.com)$/.test(parsed.hostname)
  ) {
    return null
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) return null
  const format = (response.headers.get("content-type") ?? "image/png").split("/")[1]!.split(";")[0]!
  return { format, base64: Buffer.from(await response.arrayBuffer()).toString("base64") }
}

/**
 * Gera a resposta do assistente para `userMessage`, em streaming, e grava tudo na
 * mensagem `assistantMessageId` (histórico completo, D27). Parar no meio salva o parcial.
 * Com `continueFrom`, a resposta começa com o texto daquela (cortada) e segue dali (D69).
 */
export async function generateReply(params: {
  conversation: Conversation
  userMessage: Message
  assistantMessageId: string
  options: ReplyOptions
  continueFrom?: Message
  emit: Emit
  signal: AbortSignal
}) {
  const { conversation, userMessage, assistantMessageId, continueFrom, emit, signal } = params
  const settings = await getSettings()
  const convSettings = conversation.settings as ReplyOptions
  const model = params.options.model || conversation.model || settings.chatDefaultModel
  const effort =
    params.options.reasoningEffort ?? convSettings.reasoningEffort ?? settings.chatReasoningEffort
  const webSearch = params.options.webSearch ?? convSettings.webSearch ?? false
  const imageGeneration = params.options.imageGeneration ?? convSettings.imageGeneration ?? false
  const codeInterpreter = params.options.codeInterpreter ?? convSettings.codeInterpreter ?? false
  const temperature = params.options.temperature ?? convSettings.temperature ?? null

  const parts: MessagePart[] = []
  const sources = new Map<string, string>()
  const savedContainerFiles = new Set<string>()
  const usage = emptyUsage()
  let text = ""
  let webSearchCalls = 0
  let imagesGenerated = 0
  let containersCreated = 0
  let external = false
  let incompleteReason: string | null = null
  let historyFrom: string | null = null
  let contextTokens = 0

  const onPart = (part: MessagePart) => {
    parts.push(part)
    emit("part", part)
  }

  try {
    const all = await listMessages(conversation.id)
    const branch = branchTo(all, userMessage.id)
    const folder = await folderOf(conversation)
    const instructions = await buildInstructions(conversation, settings, folder)

    // D67: histórico dentro do orçamento; o começo vira resumo quando passa do teto.
    const compaction = await compactBranch({
      conversationId: conversation.id,
      branch,
      budget: await contextBudget(model),
      fixedTokens: estimateTokens(instructions) + (continueFrom ? messageTokens(continueFrom) : 0),
      onSummarizing: () => emit("status", { tool: "compact", state: "running" }),
    })
    const history = branch.slice(compaction.startIndex)
    historyFrom = compaction.startIndex > 0 ? (history[0]?.id ?? null) : null
    const built = await buildInput(history)
    const input: ResponseInputItem[] = built.input
    if (compaction.summary) {
      input.unshift({
        role: "developer",
        content: `Resumo da parte anterior desta conversa (as mensagens originais não estão aqui):\n\n${compaction.summary}`,
      })
    }
    if (compaction.startIndex > 0) onPart({ type: "compacted", messages: compaction.startIndex })

    const userHasFiles = (userMessage.content as MessagePart[]).some((part) => part.type === "file")
    external = userHasFiles || built.hasAttachments

    const rag = await retrieveContext(
      conversation,
      userMessage.contentText ?? "",
      branchFileIds(branch),
    )
    if (rag.text) {
      input.splice(Math.max(input.length - 1, 0), 0, { role: "developer", content: rag.text })
      if (rag.usedFiles) external = true
    }
    if (rag.part) onPart(rag.part)

    // Continuar (D69): a resposta nova começa com o texto da cortada.
    if (continueFrom) {
      const previous = continueFrom.content as MessagePart[]
      text = partsToText(previous)
      if (text) emit("delta", { text })
      for (const part of previous) {
        if (["text", "context", "compacted"].includes(part.type)) continue
        if (part.type === "sources") {
          for (const item of part.items) sources.set(item.url, item.title)
          continue
        }
        onPart(part)
      }
      input.push(
        { role: "assistant", content: text },
        {
          role: "developer",
          content:
            "A resposta acima foi interrompida. Continue exatamente de onde ela parou, sem repetir nada e sem comentar a interrupção.",
        },
      )
    }

    const tools: Tool[] = [fetchUrlTool]
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
    if (codeInterpreter) {
      emit("status", { tool: "code_interpreter", state: "preparing" })
      try {
        const container = await prepareContainer(
          conversation.id,
          await codeInterpreterFiles(conversation, branch),
        )
        if (container.created) containersCreated += 1
        tools.push({ type: "code_interpreter", container: container.containerId })
      } catch (error) {
        if (isAbort(error, signal)) throw error
        throw new Error("Não foi possível preparar o interpretador de código.", { cause: error })
      }
    }
    const include: ResponseIncludable[] = ["reasoning.encrypted_content"]
    if (codeInterpreter) include.push("code_interpreter_call.outputs")

    // Entre rodadas de tools, separa os textos; na continuação, o primeiro trecho cola direto.
    let separator = continueFrom ? "" : "\n\n"
    let useTemperature = temperature !== null && !noTemperature.has(model)

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const request = () =>
        openai().responses.create(
          {
            model,
            instructions,
            input,
            ...(tools.length ? { tools } : {}),
            ...(effort && effort !== "auto" ? { reasoning: { effort: effort as "low" } } : {}),
            ...(useTemperature ? { temperature: temperature! } : {}),
            // Histórico é nosso (store: false); o raciocínio volta criptografado entre rodadas de tools.
            store: false,
            include,
            stream: true,
          },
          { signal },
        )
      let stream: Awaited<ReturnType<typeof request>>
      try {
        stream = await request()
      } catch (error) {
        if (!useTemperature || !isTemperatureError(error)) throw error
        // D71: modelo de raciocínio não aceita temperatura; segue sem e não tenta mais.
        noTemperature.add(model)
        useTemperature = false
        stream = await request()
      }

      let output: ResponseOutputItem[] = []
      let roundText = ""
      for await (const event of stream) {
        switch (event.type) {
          case "response.output_text.delta":
            if (!roundText && text && separator) {
              text += separator
              emit("delta", { text: separator })
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
          case "response.code_interpreter_call.in_progress":
          case "response.code_interpreter_call.interpreting":
            emit("status", { tool: "code_interpreter", state: "running" })
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
            if (item.type === "code_interpreter_call") {
              const logs = (item.outputs ?? [])
                .flatMap((out) => (out.type === "logs" ? [out.logs] : []))
                .join("\n")
                .trim()
              onPart({
                type: "code",
                code: item.code ?? "",
                logs: logs ? truncate(logs, 4_000) : null,
              })
              for (const out of item.outputs ?? []) {
                if (out.type !== "image") continue
                const image = await downloadCodeImage(out.url).catch(() => null)
                if (!image) continue
                const file = await saveGeneratedImage({
                  ...image,
                  prompt: "Gráfico gerado pelo interpretador de código",
                  messageId: assistantMessageId,
                  conversationId: conversation.id,
                })
                onPart({ type: "image", fileId: file.id, prompt: null })
                emit("image", { fileId: file.id, url: await fileUrl(file) })
              }
            }
            if (item.type === "message") {
              for (const content of item.content) {
                if (content.type !== "output_text") continue
                for (const annotation of content.annotations) {
                  if (annotation.type === "url_citation")
                    sources.set(annotation.url, annotation.title)
                  if (
                    annotation.type === "container_file_citation" &&
                    !savedContainerFiles.has(annotation.file_id)
                  ) {
                    // Arquivo criado pelo código: copia para o R2 antes de o container expirar.
                    savedContainerFiles.add(annotation.file_id)
                    const buffer = await downloadContainerFile(
                      annotation.container_id,
                      annotation.file_id,
                    ).catch(() => null)
                    if (!buffer) continue
                    const mime = mimeFor(annotation.filename)
                    const file = await saveGeneratedFile({
                      buffer,
                      name: annotation.filename,
                      mime,
                      conversationId: conversation.id,
                    })
                    onPart({ type: "file", fileId: file.id, name: file.name, mime })
                  }
                }
              }
            }
            break
          }
          case "response.completed":
            output = event.response.output
            if (round === 0) contextTokens = fromResponsesUsage(event.response.usage).input
            addUsage(usage, fromResponsesUsage(event.response.usage))
            break
          case "response.failed":
            throw new Error(
              event.response.error?.message ?? "A OpenAI não conseguiu gerar a resposta.",
            )
          case "response.incomplete":
            output = event.response.output
            if (round === 0) contextTokens = fromResponsesUsage(event.response.usage).input
            addUsage(usage, fromResponsesUsage(event.response.usage))
            incompleteReason = event.response.incomplete_details?.reason ?? "max_output_tokens"
            break
          case "error":
            throw new Error(event.message)
        }
      }
      separator = "\n\n"

      // Cortada: as chamadas de função podem estar pela metade; para aqui.
      if (incompleteReason) break
      const calls = output.filter((item) => item.type === "function_call")
      if (!calls.length) break

      // Devolve tudo o que o modelo produziu (inclusive o raciocínio criptografado) + os resultados.
      input.push(...(output as ResponseInputItem[]))
      for (const call of calls) {
        emit("status", { tool: call.name, state: "running" })
        const result = await runTool(call.name, call.arguments, {
          conversationId: conversation.id,
          messageId: assistantMessageId,
          external: () => external,
          markExternal: () => {
            external = true
          },
          onPart,
          signal,
        })
        input.push({ type: "function_call_output", call_id: call.call_id, output: result.output })
      }
    }

    if (incompleteReason) {
      const message = incompleteText[incompleteReason] ?? "A resposta ficou incompleta."
      return await finish("incomplete", message, branch)
    }
    return await finish("completed", undefined, branch)
  } catch (error) {
    if (isAbort(error, signal)) return await finish("stopped")
    const message = error instanceof Error ? error.message : "Erro desconhecido"
    emit("error", { error: "generation_failed", message })
    return await finish("error", message)
  }

  async function finish(
    status: "completed" | "stopped" | "error" | "incomplete",
    errorMessage?: string,
    branch?: Message[],
  ) {
    if (sources.size) {
      parts.push({ type: "sources", items: [...sources].map(([url, title]) => ({ url, title })) })
    }
    const content: MessagePart[] = [...(text ? [{ type: "text" as const, text }] : []), ...parts]
    const textCost = await tokenCost(model, usage)
    const searchCost = webSearchCalls * settings.webSearchUsdPerCall
    const imageCost = imagesGenerated * IMAGE_COST_ESTIMATE[settings.imageQuality]
    const containerCost = containersCreated * settings.codeInterpreterUsdPerContainer
    const contextParams: ContextParams = {
      historyFrom,
      ...(contextTokens ? { contextTokens } : {}),
    }

    const [saved] = await db
      .update(messages)
      .set({
        content,
        contentText: partsToText(content) || null,
        model,
        params: {
          reasoningEffort: effort,
          webSearch,
          imageGeneration,
          codeInterpreter,
          ...(temperature !== null ? { temperature } : {}),
          ...(continueFrom ? { continuedFrom: continueFrom.id } : {}),
          ...contextParams,
        },
        status,
        error: errorMessage ?? null,
        tokensIn: usage.input,
        tokensCached: usage.cached,
        tokensOut: usage.output,
        tokensReasoning: usage.reasoning,
        costUsd: textCost + searchCost + imageCost + containerCost,
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
    if (containersCreated) {
      await recordUsage({
        source: "chat",
        model: "code_interpreter",
        units: { containers: containersCreated, estimated: 1 },
        costUsd: containerCost,
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
      // D67: resume em background antes de a conversa chegar no teto.
      if (branch && saved && (await needsCompaction(conversation.id, [...branch, saved], model))) {
        await enqueue(
          "conversation.compact",
          { conversationId: conversation.id },
          { singleton: true, key: `compact:${conversation.id}` },
        )
      }
    }
    return saved!
  }
}
