import { asc, eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "../../db/client.js"
import { personas } from "../../db/schema.js"
import { notFound } from "../../lib/http.js"

/** Personas (D80): quem responde no chat. Sem persona = "Padrão" (só as instruções gerais). */
export type Persona = typeof personas.$inferSelect

export const personaSchema = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string().nullable(),
  description: z.string(),
  instructions: z.string(),
  position: z.number(),
})

export const personaColumns = {
  id: personas.id,
  name: personas.name,
  emoji: personas.emoji,
  description: personas.description,
  instructions: personas.instructions,
  position: personas.position,
}

/** O que cada resposta guarda de quem a gerou (sobrevive a renomear ou apagar a persona). */
export const personaRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string().nullable(),
})
export type PersonaRef = z.infer<typeof personaRefSchema>

export const toPersonaRef = (persona: Pick<Persona, "id" | "name" | "emoji">): PersonaRef => ({
  id: persona.id,
  name: persona.name,
  emoji: persona.emoji,
})

export function listPersonas() {
  return db
    .select(personaColumns)
    .from(personas)
    .orderBy(asc(personas.position), asc(personas.name))
}

/** `null`/`undefined` = padrão. Persona que não existe mais também cai no padrão. */
export async function findPersona(id: string | null | undefined) {
  if (!id) return null
  const [row] = await db.select().from(personas).where(eq(personas.id, id))
  return row ?? null
}

/** Para rotas que recebem `personaId`: um id inexistente é erro do pedido (404). */
export async function checkPersona(id: string | null | undefined) {
  if (id && !(await findPersona(id))) throw notFound("Persona")
}
