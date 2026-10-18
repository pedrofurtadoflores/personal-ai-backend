import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { z } from "zod"

// Testes nunca leem o .env de desenvolvimento: ele tem chaves reais (OpenAI, R2).
if (process.env.NODE_ENV !== "test") {
  // Resolve a partir deste arquivo (src/config ou dist/config), não do diretório atual.
  const envFile = fileURLToPath(new URL("../../.env", import.meta.url))
  // loadEnvFile não sobrescreve variáveis já definidas (Railway).
  if (existsSync(envFile)) process.loadEnvFile(envFile)
}

const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/

/**
 * Faixas de onde o proxy da Railway conecta. Um cliente da internet não consegue abrir
 * conexão a partir delas, então só o IP que o proxy anexou ao X-Forwarded-For é aceito.
 */
export const DEFAULT_TRUSTED_PROXIES = "loopback,linklocal,uniquelocal,100.64.0.0/10"

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3333),
    /** Local: só a própria máquina. Docker/Railway definem HOST=:: */
    HOST: z.string().default("127.0.0.1"),
    /**
     * "false" ou lista de IPs/CIDRs dos proxies confiáveis. "true" é recusado: confiaria
     * em qualquer X-Forwarded-For, que o cliente pode falsificar.
     */
    TRUST_PROXY: z
      .string()
      .refine((value) => value !== "true", {
        message: 'TRUST_PROXY="true" aceita IP falsificado; use uma lista de faixas',
      })
      .optional(),
    DATABASE_URL: z.url(),
    APP_PASSWORD_HASH: z
      .string()
      .regex(BCRYPT_HASH, "APP_PASSWORD_HASH deve ser um hash bcrypt (npm run hash-password)"),
    JWT_SECRET: z.string().min(32, "JWT_SECRET precisa ter pelo menos 32 caracteres"),
    JWT_EXPIRES_IN: z
      .string()
      .regex(/^[1-9]\d*[smhd]$/, "JWT_EXPIRES_IN deve ser como 30d, 12h ou 15m")
      .default("30d"),
    FRONTEND_URL: z
      .string()
      .transform((value) =>
        value
          .split(",")
          .map((url) => url.trim().replace(/\/+$/, ""))
          .filter(Boolean),
      )
      .pipe(z.array(z.url()).min(1)),
    /** Regex opcional para os previews da Vercel (ex.: ^https://personal-ai-frontend-.*\.vercel\.app$). */
    FRONTEND_URL_PATTERN: z
      .string()
      .refine((value) => value.startsWith("^") && value.endsWith("$"), {
        message: "FRONTEND_URL_PATTERN precisa começar com ^ e terminar com $",
      })
      .transform((value) => new RegExp(value))
      .optional(),
    /** Teto de tentativas de login por minuto somando todos os IPs (protege a CPU do bcrypt). */
    LOGIN_GLOBAL_MAX_PER_MINUTE: z.coerce.number().int().positive().default(30),
    OPENAI_API_KEY: z.string().optional(),
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().optional(),
  })
  .transform((env) => ({
    ...env,
    TRUST_PROXY: resolveTrustProxy(env.TRUST_PROXY, env.NODE_ENV),
  }))

function resolveTrustProxy(raw: string | undefined, nodeEnv: string): string | false {
  if (raw === undefined) return nodeEnv === "production" ? DEFAULT_TRUSTED_PROXIES : false
  return raw === "false" || raw === "" ? false : raw
}

export type Env = z.output<typeof schema>

export function parseEnv(source: Record<string, string | undefined>) {
  return schema.safeParse(source)
}

const parsed = parseEnv(process.env)

if (!parsed.success) {
  console.error("Variáveis de ambiente inválidas:\n" + z.prettifyError(parsed.error))
  process.exit(1)
}

export const env = parsed.data
