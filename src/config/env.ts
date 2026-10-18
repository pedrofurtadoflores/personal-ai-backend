import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { z } from "zod"

// Resolve a partir deste arquivo (src/config ou dist/config), não do diretório atual.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url))
// loadEnvFile não sobrescreve variáveis já definidas (testes, Railway).
if (existsSync(envFile)) process.loadEnvFile(envFile)

const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3333),
    /** Local: só a própria máquina. Docker/Railway definem HOST=:: */
    HOST: z.string().default("127.0.0.1"),
    /** Atrás do proxy da Railway, o IP real vem em X-Forwarded-For. */
    TRUST_PROXY: z.stringbool().optional(),
    DATABASE_URL: z.url(),
    APP_PASSWORD_HASH: z
      .string()
      .regex(BCRYPT_HASH, "APP_PASSWORD_HASH deve ser um hash bcrypt (npm run hash-password)"),
    JWT_SECRET: z.string().min(32, "JWT_SECRET precisa ter pelo menos 32 caracteres"),
    JWT_EXPIRES_IN: z
      .string()
      .regex(/^\d+[smhd]$/, "JWT_EXPIRES_IN deve ser como 30d, 12h ou 15m")
      .default("30d"),
    FRONTEND_URL: z
      .string()
      .transform((value) =>
        value
          .split(",")
          .map((url) => url.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.url()).min(1)),
    OPENAI_API_KEY: z.string().optional(),
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().optional(),
  })
  .transform((env) => ({
    ...env,
    TRUST_PROXY: env.TRUST_PROXY ?? env.NODE_ENV === "production",
  }))

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  console.error("Variáveis de ambiente inválidas:\n" + z.prettifyError(parsed.error))
  process.exit(1)
}

export const env = parsed.data
