# personal-ai-backend

Leia `../plan.md` (decisões e fases) e `../CLAUDE.md` (convenções comuns).

## Comandos

- `npm run db:up` antes de rodar dev ou testes (Postgres com pgvector no Docker).
- `npm run dev` · `npm run typecheck` · `npm run lint` · `npm test` · `npm run format`
- Mudou `src/db/schema.ts`? Rode `npm run db:generate` e faça commit da migration. Nunca edite uma migration já aplicada em produção.
- Mudou uma rota? Rode `npm run openapi:export` e faça commit do `openapi.json` (um teste confere).

## Regras

- Toda rota exige JWT. Rotas públicas declaram `config: { public: true }` (ver `src/plugins/auth.ts`).
- Rotas usam `FastifyPluginAsyncZod` com `schema` (body, params, response). A validação e o OpenAPI saem daí; não valide à mão. Envolva `response` em `withErrors()` (`src/lib/http.ts`).
- Erros: devolva `{ error: "codigo", message }` com o status certo e mensagem em pt-BR (`errorMessages`). Erros 500 são logados e respondem só `internal_error`.
- Rotas que chamam a OpenAI ou fazem trabalho caro precisam de `config.rateLimit`. A chave do rate limit é `clientKey(request.ip)` (IPv6 agrupado por /64).
- `TRUST_PROXY` é uma lista de faixas de proxy, nunca `true` (aceitaria `X-Forwarded-For` falsificado).
- Mensagens e sinapses nunca são apagadas de verdade no fluxo normal: use `deleted_at` (D27).
- `sinapse_links` exige `sinapse_a < sinapse_b`: use `orderedPair()` (`src/modules/sinapses/links.ts`), que também normaliza para minúsculas.
- Embeddings sempre gravam `embedding_model` junto.
- Testes de integração usam `app.inject()` contra o banco `personal_ai_test` (criado pelo `test/global-setup.ts`). Testes nunca leem o `.env`: só o que está em `vitest.config.ts`.

## Módulos (src/modules)

- `chat/`: `orchestrator.ts` (streaming, loop de tools, custo; parar salva o parcial), `context.ts` (instruções estáveis → histórico → RAG antes da última mensagem, D41), `tools.ts` (tools de sinapse, D37/D57), `parts.ts` (formato de `messages.content`), `jobs.ts` (título, embeddings).
- `sinapses/`: `service.ts` (toda escrita gera versão; reindexa chunks), `consolidation.ts` (job pós-ociosidade, D58), `links.ts`.
- `conversations/`, `files/` (R2 + extração + chunks), `models/` (catálogo + sync), `usage/`, `settings/`, `search/`, `audio/` (ditado, TTS, sessão realtime, voice-turns), `backups/`.

## OpenAI, R2 e jobs

- Sempre `openai()` e `r2()` de `src/lib` (nunca instanciar o SDK direto). Responses API com `store: false` (D55).
- Todo consumo passa por `recordUsage()` (`src/lib/pricing.ts`); custo estimado marca `units.estimated`.
- Jobs: `registerJob()` + `enqueue()` em `src/lib/jobs.ts`. Em testes a fila fica desligada: os jobs vão para `enqueuedJobs` e o teste chama `runJobNow()`.
- Testes **nunca** chamam a OpenAI nem o R2: use `FakeOpenAI`/`FakeStorage` de `test/fakes.ts` (`setOpenAIClient`, `setStorage`).
- Mudar o streaming: o contrato SSE é a D56 (`start`, `delta`, `part`, `image`, `status`, `error`, `done`); o front lê em `src/lib/chat/live.ts`.
