import mammoth from "mammoth"
import { extractText, getDocumentProxy } from "unpdf"

const TEXT_TYPES =
  /^(text\/|application\/(json|xml|x-yaml|yaml|csv|javascript|typescript|x-sh|sql))/
const TEXT_EXTENSIONS =
  /\.(md|markdown|txt|csv|tsv|json|ya?ml|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|cs|php|sh|sql|toml|ini|log)$/i

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

export function isTextLike(mime: string, name: string) {
  return TEXT_TYPES.test(mime) || TEXT_EXTENSIONS.test(name)
}

/** Planilhas: sem texto extraído, mas o interpretador de código lê (D74). */
const SPREADSHEET = /\.(xlsx|xls|ods|parquet)$/i

export function isSpreadsheet(mime: string, name: string) {
  return (
    SPREADSHEET.test(name) ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel"
  )
}

export function isSupported(mime: string, name: string) {
  return (
    mime.startsWith("image/") ||
    mime === "application/pdf" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    isTextLike(mime, name) ||
    isSpreadsheet(mime, name)
  )
}

/** Extrai o texto de um arquivo para indexação e para mandar ao modelo. `null` = sem texto (imagem). */
export async function extractFileText(
  buffer: Buffer,
  mime: string,
  name: string,
): Promise<string | null> {
  if (mime.startsWith("image/")) return null
  if (mime === "application/pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(buffer))
    const { text } = await extractText(pdf, { mergePages: true })
    return text.trim()
  }
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const { value } = await mammoth.extractRawText({ buffer })
    return value.trim()
  }
  if (isTextLike(mime, name)) return buffer.toString("utf8").trim()
  return null
}
