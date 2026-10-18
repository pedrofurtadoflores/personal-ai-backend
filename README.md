# personal-ai-backend

API do Personal AI: Fastify + Drizzle + Postgres (pgvector). O plano e as decisões estão em `../plan.md`.

## Rodando localmente

Pré-requisitos: Node 24+ e Docker Desktop.

```bash
npm install
cp .env.example .env     # preencha as variáveis
npm run hash-password    # pede a senha sem mostrá-la; cole o hash em APP_PASSWORD_HASH
npm run db:up            # sobe o Postgres com pgvector (só em 127.0.0.1)
npm run db:migrate       # aplica as migrations (a 0000 cria a extensão vector)
npm run dev              # http://localhost:3333 · documentação em /docs
```

## Scripts

| Script              | O que faz                                     |
| ------------------- | --------------------------------------------- |
| `dev`               | Servidor com reload                           |
| `build` / `start`   | Compila para `dist/` e roda                   |
| `typecheck`         | Checa tipos de `src`, `scripts` e `test`      |
| `lint` / `format`   | ESLint / Prettier                             |
| `test`              | Testes de integração (precisa do `db:up`)     |
| `db:up` / `db:down` | Sobe/derruba o Postgres local                 |
| `db:generate`       | Gera migration a partir de `src/db/schema.ts` |
| `db:migrate`        | Aplica as migrations                          |
| `db:studio`         | Abre o Drizzle Studio                         |
| `hash-password`     | Gera o hash bcrypt da senha de login          |

## Estrutura

```
src/
  config/env.ts        variáveis de ambiente validadas com Zod
  db/                  schema, client e migrator
  lib/http.ts          formato padrão de erro da API
  plugins/auth.ts      JWT; toda rota exige token, exceto as marcadas com config.public
  modules/<módulo>/    rotas por domínio (auth, health, ...)
drizzle/               migrations SQL geradas
test/                  testes de integração (vitest + app.inject)
```

## Autenticação

- `POST /auth/login` devolve um JWT. Depois de 5 senhas erradas, o IP fica bloqueado por um tempo que dobra a cada nova falha (até 24 h).
- O token só vale enquanto a senha for a mesma: trocar `APP_PASSWORD_HASH` derruba todas as sessões.
- `POST /auth/logout-all` encerra todas as sessões sem trocar a senha.

## Deploy (Railway)

- O serviço usa o `Dockerfile`: roda como usuário sem privilégios, aplica as migrations e sobe o servidor.
- O Postgres precisa ter **pgvector** e ser **Postgres 17**, a mesma versão do `docker-compose.yml` (D35): use o template de Postgres com pgvector da Railway.
- Ative os **backups** do Postgres na Railway (D39).
- Configure as variáveis do `.env.example`, com `FRONTEND_URL` apontando para a URL da Vercel. `TRUST_PROXY` já é `true` em produção.
- `/openapi.json` exige token em produção e `/docs` só existe fora de produção.
