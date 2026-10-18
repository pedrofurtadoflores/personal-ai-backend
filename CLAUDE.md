# personal-ai-backend

Leia `../plan.md` (decisões e fases) e `../CLAUDE.md` (convenções comuns).

## Comandos

- `npm run db:up` antes de rodar dev ou testes (Postgres com pgvector no Docker).
- `npm run dev` · `npm run typecheck` · `npm run lint` · `npm test` · `npm run format`
- Mudou `src/db/schema.ts`? Rode `npm run db:generate` e faça commit da migration. Nunca edite uma migration já aplicada em produção.

## Regras

- Toda rota exige JWT. Rotas públicas declaram `config: { public: true }` (ver `src/plugins/auth.ts`).
- Rotas usam `FastifyPluginAsyncZod` com `schema` (body, params, response). A validação e o OpenAPI saem daí; não valide à mão.
- Erros: devolva `{ error: "codigo" }` com o status certo. Erros 500 são logados e respondem só `internal_error`.
- Rotas que chamam a OpenAI ou fazem trabalho caro precisam de `config.rateLimit`.
- Mensagens e sinapses nunca são apagadas de verdade no fluxo normal: use `deleted_at` (D27).
- `sinapse_links` exige `sinapse_a < sinapse_b`: use `orderedPair()`.
- Embeddings sempre gravam `embedding_model` junto.
- Testes de integração usam `app.inject()` contra o banco `personal_ai_test` (criado pelo `test/global-setup.ts`).
