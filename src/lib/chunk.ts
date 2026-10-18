/**
 * Divide texto (markdown) em pedaços para embeddings, respeitando títulos e parágrafos.
 * ~1.800 caracteres por pedaço (~450 tokens), com sobreposição para não cortar ideias.
 */
const TARGET = 1_800
const OVERLAP = 200

export function chunkText(text: string, { target = TARGET, overlap = OVERLAP } = {}): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim()
  if (!clean) return []
  if (clean.length <= target) return [clean]

  // Blocos: seções de título e parágrafos.
  const blocks = clean.split(/\n(?=#{1,6} )|\n{2,}/).filter((block) => block.trim())
  const chunks: string[] = []
  let current = ""

  const flush = () => {
    if (current.trim()) chunks.push(current.trim())
    current = current.slice(-overlap)
  }

  for (const block of blocks) {
    if (block.length > target) {
      // Bloco gigante (ex.: texto extraído de PDF sem parágrafos): corta por frases/tamanho.
      for (let start = 0; start < block.length; start += target - overlap) {
        if (current) flush()
        current = block.slice(start, start + target)
        flush()
      }
      current = ""
      continue
    }
    if (current.length + block.length + 2 > target) flush()
    current = current ? `${current}\n\n${block}` : block
  }
  if (current.trim()) chunks.push(current.trim())

  return chunks
}

/** Corta um texto longo mantendo início e fim (útil para logs e prompts). */
export function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n[… texto cortado …]`
}
