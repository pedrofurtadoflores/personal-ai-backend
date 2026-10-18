import bcrypt from "bcryptjs"
import { defineConfig } from "vitest/config"

export const TEST_PASSWORD = "senha-de-teste"

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // Cada arquivo de teste sobe seu próprio app; o banco de teste é compartilhado.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgres://personal_ai:personal_ai@localhost:5432/personal_ai_test",
      APP_PASSWORD_HASH: bcrypt.hashSync(TEST_PASSWORD, 4),
      JWT_SECRET: "segredo-de-teste-com-pelo-menos-32-caracteres",
      FRONTEND_URL: "http://localhost:3000",
      TRUST_PROXY: "false",
    },
  },
})
