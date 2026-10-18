/**
 * Preços oficiais (Standard, USD por 1M tokens, contexto curto) tirados de
 * https://developers.openai.com/api/docs/pricing em 18/10/2026. Editáveis no painel.
 *
 * A página de preços não descreve as famílias novas (sol/luna/terra/astra): as recomendações
 * delas se baseiam só na faixa de preço e dizem isso.
 */
type Seed = {
  kind: "chat" | "image" | "embedding" | "transcription" | "speech" | "realtime"
  name: string
  input?: number
  cached?: number
  output?: number
  extra?: Record<string, number>
  recommendation?: string
  example?: string
}

export const PRICES_SOURCE = "developers.openai.com/api/docs/pricing (18/10/2026)"

export const catalogSeed: Record<string, Seed> = {
  // ─── GPT-6 ──────────────────────────────────────────────────────────────────
  "gpt-6-astra": {
    kind: "chat",
    name: "GPT-6 Astra",
    input: 10,
    cached: 1,
    output: 50,
    recommendation:
      "A faixa mais cara da família GPT-6: reserve para problemas difíceis em que a qualidade compensa o custo.",
    example: "Revise a arquitetura deste sistema e aponte riscos que eu não vi.",
  },
  "gpt-6-sol": {
    kind: "chat",
    name: "GPT-6 Sol",
    input: 2,
    cached: 0.2,
    output: 10,
    recommendation:
      "Faixa intermediária da família GPT-6, com bom equilíbrio entre custo e qualidade. Padrão do chat.",
    example: "Me ajude a montar um plano de estudos de 3 meses para aprender Rust.",
  },
  "gpt-6.1-sol": {
    kind: "chat",
    name: "GPT-6.1 Sol",
    input: 2,
    cached: 0.1,
    output: 10,
    recommendation:
      "Versão 6.1 da faixa Sol: mesmo preço de entrada e saída do GPT-6 Sol, com cache mais barato.",
    example: "Analise este contrato e resuma as cláusulas que me afetam.",
  },
  "gpt-6-luna": {
    kind: "chat",
    name: "GPT-6 Luna",
    input: 0.1,
    cached: 0.01,
    output: 0.5,
    recommendation:
      "A faixa mais barata da família GPT-6: ótima para perguntas rápidas e tarefas simples. Padrão do background.",
    example: "Traduza este parágrafo para inglês.",
  },
  // ─── GPT-5.6 ────────────────────────────────────────────────────────────────
  "gpt-5.6-sol": {
    kind: "chat",
    name: "GPT-5.6 Sol",
    input: 4,
    cached: 0.4,
    output: 20,
    recommendation: "A faixa mais cara da família GPT-5.6 (com preço promocional até 21/11/2026).",
    example: "Compare estas três propostas e recomende uma, com prós e contras.",
  },
  "gpt-5.6-terra": {
    kind: "chat",
    name: "GPT-5.6 Terra",
    input: 2,
    cached: 0.2,
    output: 12,
    recommendation: "Faixa intermediária da família GPT-5.6.",
    example: "Escreva um e-mail formal recusando uma proposta de emprego.",
  },
  "gpt-5.6-luna": {
    kind: "chat",
    name: "GPT-5.6 Luna",
    input: 0.2,
    cached: 0.02,
    output: 1.2,
    recommendation: "A faixa mais barata da família GPT-5.6.",
    example: "Liste 10 ideias de nome para um podcast sobre filosofia.",
  },
  // ─── GPT-5.x ────────────────────────────────────────────────────────────────
  "gpt-5.5": {
    kind: "chat",
    name: "GPT-5.5",
    input: 5,
    cached: 0.5,
    output: 30,
    recommendation: "Modelo de raciocínio forte da geração anterior; mais caro que o GPT-6 Sol.",
    example: "Encontre o erro lógico neste argumento.",
  },
  "gpt-5.5-pro": {
    kind: "chat",
    name: "GPT-5.5 Pro",
    input: 30,
    output: 180,
    recommendation: "Muito caro: só para tarefas críticas em que cada detalhe importa.",
    example: "Valide esta demonstração matemática passo a passo.",
  },
  "gpt-5.4": {
    kind: "chat",
    name: "GPT-5.4",
    input: 2.5,
    cached: 0.25,
    output: 15,
    recommendation: "Bom modelo geral da geração 5.4.",
    example: "Explique como funciona um índice HNSW.",
  },
  "gpt-5.4-mini": {
    kind: "chat",
    name: "GPT-5.4 mini",
    input: 0.75,
    cached: 0.075,
    output: 4.5,
    recommendation: "Rápido e barato da geração 5.4.",
    example: "Reescreva este texto de forma mais clara.",
  },
  "gpt-5.4-nano": {
    kind: "chat",
    name: "GPT-5.4 nano",
    input: 0.2,
    cached: 0.02,
    output: 1.25,
    recommendation: "O menor da geração 5.4: classificação e respostas curtas.",
    example: "Esta frase é positiva ou negativa?",
  },
  "gpt-5.4-pro": {
    kind: "chat",
    name: "GPT-5.4 Pro",
    input: 30,
    output: 180,
    recommendation: "Muito caro: só para tarefas críticas.",
    example: "Audite este código procurando falhas de segurança.",
  },
  "gpt-5.2": {
    kind: "chat",
    name: "GPT-5.2",
    input: 1.75,
    cached: 0.175,
    output: 14,
    recommendation: "Geração 5.2, ainda competente.",
    example: "Resuma este artigo em 5 tópicos.",
  },
  "gpt-5.1": {
    kind: "chat",
    name: "GPT-5.1",
    input: 1.25,
    cached: 0.125,
    output: 10,
    recommendation: "Geração 5.1.",
    example: "Me dê um roteiro de viagem de 4 dias em Lisboa.",
  },
  "gpt-5": {
    kind: "chat",
    name: "GPT-5",
    input: 1.25,
    cached: 0.125,
    output: 10,
    recommendation: "Primeira geração GPT-5.",
    example: "Explique a diferença entre TCP e UDP.",
  },
  "gpt-5-mini": {
    kind: "chat",
    name: "GPT-5 mini",
    input: 0.25,
    cached: 0.025,
    output: 2,
    recommendation: "Barato e rápido, da primeira geração GPT-5.",
    example: "Corrija a gramática deste texto.",
  },
  "gpt-5-nano": {
    kind: "chat",
    name: "GPT-5 nano",
    input: 0.05,
    cached: 0.005,
    output: 0.4,
    recommendation: "O mais barato da lista: tarefas triviais.",
    example: "Extraia a data desta frase.",
  },
  "gpt-5-pro": { kind: "chat", name: "GPT-5 Pro", input: 15, output: 120 },
  "gpt-5.2-pro": { kind: "chat", name: "GPT-5.2 Pro", input: 21, output: 168 },
  "chat-latest": {
    kind: "chat",
    name: "Chat (latest)",
    input: 5,
    cached: 0.5,
    output: 30,
    recommendation: "Aponta para o modelo mais recente do ChatGPT (pode mudar sem aviso).",
  },
  "gpt-5.3-codex": {
    kind: "chat",
    name: "GPT-5.3 Codex",
    input: 1.75,
    cached: 0.175,
    output: 14,
    recommendation: "Especializado em código.",
    example: "Escreva um script que renomeia arquivos por data.",
  },
  // ─── Gerações anteriores ────────────────────────────────────────────────────
  "gpt-4.1": { kind: "chat", name: "GPT-4.1", input: 2, cached: 0.5, output: 8 },
  "gpt-4.1-mini": { kind: "chat", name: "GPT-4.1 mini", input: 0.4, cached: 0.1, output: 1.6 },
  "gpt-4.1-nano": { kind: "chat", name: "GPT-4.1 nano", input: 0.1, cached: 0.025, output: 0.4 },
  "gpt-4o": { kind: "chat", name: "GPT-4o", input: 2.5, cached: 1.25, output: 10 },
  "gpt-4o-mini": { kind: "chat", name: "GPT-4o mini", input: 0.15, cached: 0.075, output: 0.6 },
  o3: { kind: "chat", name: "o3", input: 2, cached: 0.5, output: 8 },
  "o4-mini": { kind: "chat", name: "o4-mini", input: 1.1, cached: 0.275, output: 4.4 },
  "o3-mini": { kind: "chat", name: "o3-mini", input: 1.1, cached: 0.55, output: 4.4 },
  o1: { kind: "chat", name: "o1", input: 15, cached: 7.5, output: 60 },
  "o1-pro": { kind: "chat", name: "o1-pro", input: 150, output: 600 },
  // ─── Embeddings ─────────────────────────────────────────────────────────────
  "text-embedding-3-small": { kind: "embedding", name: "Embedding 3 small", input: 0.02 },
  "text-embedding-3-large": { kind: "embedding", name: "Embedding 3 large", input: 0.13 },
  "text-embedding-ada-002": { kind: "embedding", name: "Embedding ada-002", input: 0.1 },
  // ─── Imagem (por 1M tokens: texto de entrada / imagem de saída) ─────────────
  "gpt-image-2": {
    kind: "image",
    name: "GPT Image 2",
    input: 5,
    cached: 1.25,
    output: 30,
    extra: { imageInput: 8, imageCachedInput: 2 },
  },
  "gpt-image-2.5-flare": {
    kind: "image",
    name: "GPT Image 2.5 Flare",
    input: 5,
    cached: 1.25,
    output: 30,
    extra: { imageInput: 8, imageCachedInput: 2 },
  },
  "gpt-image-2.5-sunburst": {
    kind: "image",
    name: "GPT Image 2.5 Sunburst",
    input: 5,
    cached: 1.25,
    output: 30,
    extra: { imageInput: 8, imageCachedInput: 2 },
  },
  "gpt-image-1.5": {
    kind: "image",
    name: "GPT Image 1.5",
    input: 5,
    cached: 1.25,
    output: 32,
    extra: { imageInput: 8, imageCachedInput: 2 },
  },
  "gpt-image-1": { kind: "image", name: "GPT Image 1", input: 5, cached: 1.25, output: 40 },
  "gpt-image-1-mini": { kind: "image", name: "GPT Image 1 mini", input: 2, cached: 0.2, output: 8 },
  // ─── Áudio ──────────────────────────────────────────────────────────────────
  "gpt-4o-transcribe": {
    kind: "transcription",
    name: "GPT-4o Transcribe",
    input: 2.5,
    output: 10,
    extra: { perMinute: 0.006 },
  },
  "gpt-4o-mini-transcribe": {
    kind: "transcription",
    name: "GPT-4o mini Transcribe",
    input: 1.25,
    output: 5,
    extra: { perMinute: 0.003 },
  },
  "gpt-transcribe": { kind: "transcription", name: "GPT Transcribe", extra: { perMinute: 0.0045 } },
  "whisper-1": { kind: "transcription", name: "Whisper", extra: { perMinute: 0.006 } },
  "gpt-4o-mini-tts": {
    kind: "speech",
    name: "GPT-4o mini TTS",
    input: 0.6,
    output: 12,
    // Estimativa da própria OpenAI para o áudio de saída: ~US$ 0,015 por minuto.
    extra: { perMinute: 0.015 },
  },
  "tts-1": { kind: "speech", name: "TTS-1", extra: { perMillionChars: 15 } },
  "tts-1-hd": { kind: "speech", name: "TTS-1 HD", extra: { perMillionChars: 30 } },
  // ─── Realtime (texto aqui; áudio em extra) ──────────────────────────────────
  "gpt-realtime-2.1": {
    kind: "realtime",
    name: "GPT Realtime 2.1",
    input: 4,
    cached: 0.4,
    output: 24,
    extra: { audioInput: 32, audioCachedInput: 0.4, audioOutput: 64 },
  },
  "gpt-realtime-2.1-mini": {
    kind: "realtime",
    name: "GPT Realtime 2.1 mini",
    input: 0.6,
    cached: 0.06,
    output: 2.4,
    extra: { audioInput: 10, audioCachedInput: 0.3, audioOutput: 20 },
  },
}

/** Classifica um modelo de /v1/models pelo id. `null` = fora do app (legado, moderação, vídeo). */
export function classifyModel(id: string): Seed["kind"] | null {
  if (catalogSeed[id]) return catalogSeed[id].kind
  if (/embedding/.test(id)) return "embedding"
  if (/^(gpt-image|chatgpt-image|dall-e)/.test(id)) return "image"
  if (/transcribe|whisper/.test(id)) return "transcription"
  if (/tts/.test(id)) return "speech"
  if (/realtime|^gpt-live|^gpt-audio/.test(id)) return "realtime"
  if (/moderation|^sora|^babbage|^davinci|instruct|search-preview|search-api/.test(id)) return null
  if (/^gpt-3\.5|^gpt-4(-|$)|^gpt-4-turbo/.test(id)) return null // só Chat Completions
  if (/^(gpt-|o\d|chat-latest|chatgpt-)/.test(id)) return "chat"
  return null
}

export const isSnapshotId = (id: string) => /-\d{4}-\d{2}-\d{2}$/.test(id)
