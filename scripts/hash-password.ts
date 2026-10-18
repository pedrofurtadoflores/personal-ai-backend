/**
 * Gera o hash bcrypt para APP_PASSWORD_HASH.
 * A senha é lida do terminal (sem eco) ou do stdin, nunca de argumento,
 * para não ficar no histórico do shell.
 */
import { createInterface } from "node:readline"
import bcrypt from "bcryptjs"

const BCRYPT_MAX_BYTES = 72

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = ""
    for await (const chunk of process.stdin) data += chunk
    return data.replace(/\r?\n$/, "")
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  // API interna do readline: trocá-la é o jeito padrão de esconder o que é digitado.
  const output = rl as unknown as { _writeToOutput: (text: string) => void }
  const original = output._writeToOutput
  const ask = (question: string) =>
    new Promise<string>((resolve) => {
      process.stdout.write(question)
      output._writeToOutput = () => {}
      rl.question("", (answer) => {
        output._writeToOutput = original
        process.stdout.write("\n")
        resolve(answer)
      })
    })

  const first = await ask("Nova senha: ")
  const second = await ask("Repita a senha: ")
  rl.close()

  if (first !== second) throw new Error("As senhas não conferem.")
  return first
}

try {
  const password = await readPassword()
  if (password.length < 8) throw new Error("Use pelo menos 8 caracteres.")
  if (Buffer.byteLength(password, "utf8") > BCRYPT_MAX_BYTES) {
    throw new Error(`Use no máximo ${BCRYPT_MAX_BYTES} bytes (o bcrypt ignora o resto).`)
  }
  const hash = await bcrypt.hash(password, 12)
  console.log(`\nCole no .env (com as aspas simples):\nAPP_PASSWORD_HASH='${hash}'`)
} catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}
