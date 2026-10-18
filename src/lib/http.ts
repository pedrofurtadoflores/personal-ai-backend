import { z } from "zod"

/** Formato único de erro da API: `{ error: "codigo_em_snake_case", message? }`. */
export const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
  details: z.unknown().optional(),
})

export type ErrorResponse = z.infer<typeof errorResponse>

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

export function errorCode(status: number, fastifyCode?: string): string {
  return (fastifyCode && codeByFastifyCode[fastifyCode]) ?? codeByStatus[status] ?? "request_error"
}
