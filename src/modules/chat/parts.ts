import { z } from "zod"

/**
 * Partes de uma mensagem (coluna `messages.content`). O texto puro fica também em
 * `content_text` para busca e embeddings.
 */
export const messagePart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  /** Anexo enviado pelo usuário. */
  z.object({
    type: z.literal("file"),
    fileId: z.string(),
    name: z.string(),
    mime: z.string(),
  }),
  /** Imagem gerada pela tool de imagem. */
  z.object({
    type: z.literal("image"),
    fileId: z.string(),
    prompt: z.string().nullable(),
  }),
  /** Fontes citadas pela busca web. */
  z.object({
    type: z.literal("sources"),
    items: z.array(z.object({ url: z.string(), title: z.string() })),
  }),
  /** Mudança em sinapse feita durante a resposta (chip com "desfazer"). */
  z.object({
    type: z.literal("sinapse"),
    action: z.enum(["created", "updated", "linked", "suggested"]),
    sinapseId: z.string().nullable(),
    title: z.string(),
    versionId: z.string().nullable(),
    suggestionId: z.string().nullable(),
  }),
  /** Memória que entrou no contexto desta resposta. */
  z.object({
    type: z.literal("context"),
    sinapses: z.array(z.object({ id: z.string(), title: z.string() })),
    files: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
  /** Uso de tool que não gera conteúdo próprio (ex.: buscas feitas). */
  z.object({
    type: z.literal("tool"),
    name: z.string(),
    detail: z.string().nullable(),
  }),
])

export type MessagePart = z.infer<typeof messagePart>

export const partsToText = (parts: MessagePart[]) =>
  parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
