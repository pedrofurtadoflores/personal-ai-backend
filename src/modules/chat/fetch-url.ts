/**
 * Tool `fetch_url` (D75): lê uma página ou PDF a partir de uma URL que o usuário mandou.
 *
 * Proteção contra SSRF: só http(s) em portas comuns, e o endereço resolvido no DNS precisa ser
 * público. A checagem roda no `lookup` da própria conexão (o IP verificado é o IP conectado, o
 * que impede DNS rebinding) e de novo a cada redirecionamento.
 */
import dns, { type LookupAddress } from "node:dns"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import { truncate } from "../../lib/chunk.js"
import { extractFileText } from "../files/extract.js"

const MAX_BYTES = 3 * 1024 * 1024
const MAX_CHARS = 40_000
const MAX_REDIRECTS = 5
const TIMEOUT_MS = 12_000
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"])

const blocked = new net.BlockList()
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4")
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6")
}

export class FetchUrlError extends Error {}

/** Endereço público? IPv4 mapeado em IPv6 (::ffff:10.0.0.1) é conferido como IPv4. */
export function isPublicAddress(address: string) {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1]
  if (mapped) return isPublicAddress(mapped)
  const family = net.isIP(address)
  if (family === 4) return !blocked.check(address, "ipv4")
  if (family === 6)
    return !address.toLowerCase().startsWith("::ffff:") && !blocked.check(address, "ipv6")
  return false
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void

function safeLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "")
    const list = addresses as LookupAddress[]
    if (!list.length || list.some((item) => !isPublicAddress(item.address))) {
      return callback(new FetchUrlError("Endereço não permitido (rede interna)."), "")
    }
    if (options.all) return callback(null, list)
    callback(null, list[0]!.address, list[0]!.family)
  })
}

function checkUrl(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchUrlError("Só endereços http ou https.")
  }
  if (url.username || url.password) throw new FetchUrlError("URL com usuário e senha não é aceita.")
  if (!ALLOWED_PORTS.has(url.port)) throw new FetchUrlError("Porta não permitida.")
  const host = url.hostname.replace(/^\[|\]$/g, "")
  // IP literal não passa pelo lookup: confere aqui.
  if (net.isIP(host) && !isPublicAddress(host)) {
    throw new FetchUrlError("Endereço não permitido (rede interna).")
  }
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) {
    throw new FetchUrlError("Endereço não permitido (rede interna).")
  }
}

type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

function request(url: URL, signal?: AbortSignal): Promise<RawResponse> {
  const client = url.protocol === "https:" ? https : http
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "GET",
        lookup: safeLookup as unknown as typeof dns.lookup,
        signal,
        timeout: TIMEOUT_MS,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; PersonalAI/1.0; leitura a pedido do usuário)",
          accept:
            "text/html,application/xhtml+xml,text/plain;q=0.9,application/pdf;q=0.9,*/*;q=0.5",
          "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        }
        res.on("data", (chunk: Buffer) => {
          if (settled) return
          size += chunk.length
          chunks.push(chunk)
          // Grande demais: fica com o começo.
          if (size >= MAX_BYTES) {
            done()
            res.destroy()
          }
        })
        res.on("end", done)
        res.on("error", (error) => (settled ? undefined : reject(error)))
      },
    )
    req.on("timeout", () =>
      req.destroy(new FetchUrlError("A página demorou demais para responder.")),
    )
    req.on("error", reject)
    req.end()
  })
}

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  copy: "©",
}

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const value =
        code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1))
      return Number.isFinite(value) && value > 0 && value < 0x110000
        ? String.fromCodePoint(value)
        : ""
    }
    return entities[code.toLowerCase()] ?? match
  })
}

/** HTML → texto legível (sem dependência extra): tira scripts, menus e tags; mantém parágrafos. */
export function htmlToText(html: string) {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim()
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|svg|template|iframe|head|nav|footer|form)\b[\s\S]*?<\/\1>/gi,
      " ",
    )
  // Prefere o conteúdo principal quando a página marca.
  const main = body.match(/<(article|main)\b[^>]*>([\s\S]*)<\/\1>/i)?.[2]
  if (main && main.length > 500) body = main
  const text = decodeEntities(
    body
      .replace(/<h([1-3])\b[^>]*>/gi, (_m, level: string) => `\n\n${"#".repeat(Number(level))} `)
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr|table|ul|ol|blockquote|pre)>/gi, "\n\n")
      .replace(/<\/t[dh]>/gi, " | ")
      .replace(/<[^>]+>/g, " "),
  )
  const clean = text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return { title, text: clean }
}

function decode(body: Buffer, contentType: string) {
  const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? "utf-8"
  try {
    return new TextDecoder(charset).decode(body)
  } catch {
    return body.toString("utf8")
  }
}

export type FetchedPage = { url: string; title: string; content: string; truncated: boolean }

export async function fetchUrl(rawUrl: string, signal?: AbortSignal): Promise<FetchedPage> {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    throw new FetchUrlError("URL inválida.")
  }

  for (let hop = 0; ; hop++) {
    checkUrl(url)
    const response = await request(url, signal).catch((error: unknown) => {
      if (error instanceof FetchUrlError) throw error
      throw new FetchUrlError("Não foi possível abrir a página.")
    })
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      if (hop >= MAX_REDIRECTS) throw new FetchUrlError("Redirecionamentos demais.")
      url = new URL(response.headers.location, url)
      continue
    }
    if (response.status >= 400) {
      throw new FetchUrlError(`A página respondeu com erro ${response.status}.`)
    }

    const contentType = String(response.headers["content-type"] ?? "").toLowerCase()
    let title = ""
    let text: string
    if (contentType.includes("application/pdf")) {
      text = (await extractFileText(response.body, "application/pdf", "pagina.pdf")) ?? ""
    } else if (contentType.includes("html") || contentType.includes("xml") || !contentType) {
      const page = htmlToText(decode(response.body, contentType))
      title = page.title
      text = page.text
    } else if (contentType.startsWith("text/") || contentType.includes("json")) {
      text = decode(response.body, contentType).trim()
    } else {
      throw new FetchUrlError(`Tipo de conteúdo não suportado (${contentType.split(";")[0]}).`)
    }
    if (!text) throw new FetchUrlError("A página não tem texto legível.")
    return {
      url: url.toString(),
      title,
      content: truncate(text, MAX_CHARS),
      truncated: text.length > MAX_CHARS,
    }
  }
}
