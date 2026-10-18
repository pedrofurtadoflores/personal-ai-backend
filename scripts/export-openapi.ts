/**
 * Gera openapi.json a partir das rotas. O arquivo é versionado: o front gera os tipos dele
 * e um teste falha se ele ficar diferente das rotas.
 */
import { writeFile } from "node:fs/promises"
import { buildApp } from "../src/app.js"

const app = await buildApp()
await app.ready()
await writeFile(
  new URL("../openapi.json", import.meta.url),
  JSON.stringify(app.swagger(), null, 2) + "\n",
)
await app.close()

console.log("openapi.json atualizado.")
