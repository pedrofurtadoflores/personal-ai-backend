import { z } from "zod"

/** Formato único de erro da API: `{ error: "codigo_em_snake_case", message? }`. */
export const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
  details: z.unknown().optional(),
})

export type ErrorResponse = z.infer<typeof errorResponse>

/**
 * Respostas de erro que toda rota pode devolver, para o contrato OpenAPI (e os tipos do front)
 * conhecerem o formato. Rotas públicas não declaram 401.
 */
export function withErrors<T extends Record<number, z.ZodType>>(
  responses: T,
  { auth = true }: { auth?: boolean } = {},
) {
  return {
    400: errorResponse,
    ...(auth ? { 401: errorResponse } : {}),
    429: errorResponse,
    500: errorResponse,
    ...responses,
  }
}

const codeByStatus: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "rate_limited",
}

const codeByFastifyCode: Record<string, string> = {
  FST_ERR_CTP_INVALID_JSON_BODY: "invalid_json",
  FST_ERR_CTP_EMPTY_JSON_BODY: "invalid_json",
  FST_ERR_CTP_BODY_TOO_LARGE: "payload_too_large",
  FST_ERR_CTP_INVALID_MEDIA_TYPE: "unsupported_media_type",
}

/** Mensagens próprias em pt-BR: as do Fastify vêm em inglês e expõem detalhes do framework. */
export const errorMessages: Record<string, string> = {
  bad_request: "Requisição inválida.",
  invalid_json: "O corpo da requisição não é um JSON válido.",
  validation_error: "Dados inválidos.",
  unauthorized: "Sessão inválida ou expirada.",
  forbidden: "Acesso negado.",
  not_found: "Recurso não encontrado.",
  conflict: "Conflito com o estado atual.",
  payload_too_large: "Conteúdo grande demais.",
  unsupported_media_type: "Tipo de conteúdo não suportado.",
  rate_limited: "Muitas requisições. Tente novamente mais tarde.",
  request_error: "Não foi possível processar a requisição.",
  internal_error: "Erro interno.",
}

export function errorCode(status: number, fastifyCode?: string): string {
  return (fastifyCode && codeByFastifyCode[fastifyCode]) ?? codeByStatus[status] ?? "request_error"
}
