import type { FunctionTool } from "openai/resources/responses/responses"
import { z } from "zod"
import { HttpError } from "../../lib/http.js"
import {
  applySectionOperation,
  createSinapse,
  getSinapse,
  linkSinapses,
  searchSinapses,
  similarSinapses,
  suggest,
  updateSinapse,
} from "../sinapses/service.js"
import { embedOne } from "../../lib/embeddings.js"
import type { MessagePart } from "./parts.js"

/** Similaridade de resumo acima da qual "criar" vira "atualizar a existente" (evita duplicatas). */
const DUPLICATE_THRESHOLD = 0.88

const fn = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
): FunctionTool => ({
  type: "function",
  name,
  description,
  strict: true,
  parameters: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
})

const str = (description: string) => ({ type: "string", description })

export const sinapseTools: FunctionTool[] = [
  fn("search_sinapses", "Busca na memória de longo prazo (sinapses) por tema ou palavras.", {
    query: str("O que procurar"),
  }),
  fn("read_sinapse", "Lê o conteúdo completo de uma sinapse.", { id: str("Id da sinapse") }),
  fn(
    "create_sinapse",
    "Cria uma sinapse para um tema novo. Prefira update_sinapse se o tema já existir.",
    {
      title: str("Título curto do tema"),
      emoji: str("Um emoji que represente o tema"),
      summary: str("Resumo de 1 a 3 frases"),
      content: str("Conteúdo em markdown, organizado em seções ##"),
      tags: { type: "array", items: { type: "string" }, description: "Até 5 tags curtas" },
    },
  ),
  fn("update_sinapse", "Atualiza uma sinapse existente.", {
    id: str("Id da sinapse"),
    operation: {
      type: "string",
      enum: ["append_section", "replace_section", "replace_all"],
      description:
        "append_section acrescenta; replace_section troca a seção de mesmo título; replace_all reescreve tudo",
    },
    section_title: str('Título da seção (use "" em replace_all)'),
    content: str("Markdown da seção (ou do documento inteiro em replace_all)"),
    summary: str('Novo resumo, ou "" para manter'),
    reason: str("Por que está mudando, em uma frase"),
  }),
  fn("link_sinapses", "Conecta duas sinapses relacionadas.", {
    a: str("Id de uma sinapse"),
    b: str("Id da outra sinapse"),
    reason: str("Por que estão relacionadas"),
  }),
]

const createArgs = z.object({
  title: z.string().min(1),
  emoji: z.string(),
  summary: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
})
const updateArgs = z.object({
  id: z.string(),
  operation: z.enum(["append_section", "replace_section", "replace_all"]),
  section_title: z.string(),
  content: z.string(),
  summary: z.string(),
  reason: z.string(),
})

export type ToolContext = {
  conversationId: string
  messageId: string
  /** Conteúdo externo no contexto (busca web, arquivo): escritas viram sugestões (D37). */
  external: () => boolean
  onPart: (part: MessagePart) => void
}

type ToolResult = { output: string }

export async function runSinapseTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const args = JSON.parse(rawArgs || "{}") as Record<string, unknown>
  const writeContext = {
    author: "ai" as const,
    sourceMessageId: ctx.messageId,
    conversationId: ctx.conversationId,
  }
  const externalReason =
    "Conteúdo externo no contexto (busca web ou arquivo): precisa da sua aprovação."

  try {
    switch (name) {
      case "search_sinapses": {
        const results = await searchSinapses(String(args.query ?? ""))
        return { output: JSON.stringify(results.length ? results : "Nada encontrado.") }
      }
      case "read_sinapse": {
        const sinapse = await getSinapse(String(args.id))
        return {
          output: JSON.stringify({
            id: sinapse.id,
            title: sinapse.title,
            summary: sinapse.summary,
            content: sinapse.content,
            tags: sinapse.tags,
            locked: sinapse.locked,
          }),
        }
      }
      case "create_sinapse": {
        const input = createArgs.parse(args)
        // Antes de criar, confere se já existe uma sinapse do mesmo tema.
        const { vector } = await embedOne(`# ${input.title}\n\n${input.summary}`)
        const [twin] = await similarSinapses(vector, { limit: 1 })
        if (twin && twin.score >= DUPLICATE_THRESHOLD) {
          return runSinapseTool(
            "update_sinapse",
            JSON.stringify({
              id: twin.id,
              operation: "append_section",
              section_title: input.title,
              content: input.content,
              summary: "",
              reason: `Conteúdo de "${input.title}" (tema já existente)`,
            }),
            ctx,
          )
        }
        if (ctx.external()) {
          const suggestionId = await suggest(
            null,
            { kind: "create", input },
            externalReason,
            ctx.messageId,
          )
          ctx.onPart({
            type: "sinapse",
            action: "suggested",
            sinapseId: null,
            title: input.title,
            versionId: null,
            suggestionId,
          })
          return { output: "Sugestão de nova sinapse registrada para aprovação do usuário." }
        }
        const { sinapse, versionId } = await createSinapse(input, {
          ...writeContext,
          reason: "Criada durante a conversa",
        })
        ctx.onPart({
          type: "sinapse",
          action: "created",
          sinapseId: sinapse.id,
          title: sinapse.title,
          versionId,
          suggestionId: null,
        })
        return { output: JSON.stringify({ created: sinapse.id }) }
      }
      case "update_sinapse": {
        const input = updateArgs.parse(args)
        const sinapse = await getSinapse(input.id)
        const patch = {
          content: applySectionOperation(
            sinapse.content,
            input.operation,
            input.section_title,
            input.content,
          ),
          ...(input.summary.trim() ? { summary: input.summary } : {}),
        }
        if (sinapse.locked || ctx.external()) {
          const reason = sinapse.locked
            ? `Sinapse travada. ${input.reason}`
            : `${externalReason} ${input.reason}`
          const suggestionId = await suggest(
            sinapse.id,
            { kind: "update", patch },
            reason,
            ctx.messageId,
          )
          ctx.onPart({
            type: "sinapse",
            action: "suggested",
            sinapseId: sinapse.id,
            title: sinapse.title,
            versionId: null,
            suggestionId,
          })
          return {
            output:
              "A sinapse está protegida; a mudança ficou como sugestão para o usuário aprovar.",
          }
        }
        const { versionId } = await updateSinapse(sinapse.id, patch, {
          ...writeContext,
          reason: input.reason,
        })
        ctx.onPart({
          type: "sinapse",
          action: "updated",
          sinapseId: sinapse.id,
          title: sinapse.title,
          versionId,
          suggestionId: null,
        })
        return { output: JSON.stringify({ updated: sinapse.id }) }
      }
      case "link_sinapses": {
        const a = String(args.a)
        const b = String(args.b)
        const reason = String(args.reason ?? "")
        const first = await getSinapse(a)
        const second = await getSinapse(b)
        await linkSinapses(a, b, reason, "ai")
        ctx.onPart({
          type: "sinapse",
          action: "linked",
          sinapseId: first.id,
          title: `${first.title} ↔ ${second.title}`,
          versionId: null,
          suggestionId: null,
        })
        return { output: "Conectadas." }
      }
      default:
        return { output: `Ferramenta desconhecida: ${name}` }
    }
  } catch (error) {
    const message =
      error instanceof HttpError || error instanceof z.ZodError
        ? error.message
        : "Erro ao executar a ferramenta."
    return { output: JSON.stringify({ error: message }) }
  }
}
