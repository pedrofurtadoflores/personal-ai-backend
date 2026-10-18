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

| Script              | O que faz                                                  |
| ------------------- | ---------------------------------------------------------- |
| `dev`               | Servidor com reload                                        |
| `build` / `start`   | Compila para `dist/` e roda                                |
| `typecheck`         | Checa tipos de `src`, `scripts` e `test`                   |
| `lint` / `format`   | ESLint (com regras de promises) / Prettier                 |
| `test`              | Testes de integração (precisa do `db:up`; não lê o `.env`) |
| `openapi:export`    | Regera `openapi.json`, o contrato usado pelo front         |
| `db:up` / `db:down` | Sobe/derruba o Postgres local                              |
| `db:generate`       | Gera migration a partir de `src/db/schema.ts`              |
| `db:migrate`        | Aplica as migrations                                       |
| `db:studio`         | Abre o Drizzle Studio                                      |
| `hash-password`     | Gera o hash bcrypt da senha de login                       |

## Estrutura

```
src/
  config/env.ts        variáveis de ambiente validadas com Zod
  db/                  schema, client e migrator
  lib/http.ts          formato padrão de erro e respostas de erro do OpenAPI
  lib/client-ip.ts     chave do cliente para rate limit (IPv6 agrupado por /64)
  plugins/auth.ts      JWT; toda rota exige token, exceto as marcadas com config.public
  modules/<módulo>/    rotas e regras por domínio (auth, health, sinapses, ...)
drizzle/               migrations SQL geradas
openapi.json           contrato da API (gerado; um teste confere que está em dia)
test/                  testes de integração (vitest + app.inject)
```

## O que a API faz

- **Chat** com streaming (SSE), conversas em árvore (editar/regenerar sem perder versões), pastas, lixeira, modo anônimo.
- **Sinapses** (memória): o modelo lê e escreve por tools durante a conversa; um job consolida a conversa depois de 3 min parada. Toda escrita gera versão; sinapses travadas e conteúdo externo viram sugestões.
- **Modelos**: catálogo sincronizado com o `/v1/models` da conta, com preço, recomendação e exemplo; custo de cada mensagem e tela de uso.
- **Arquivos** no R2 (upload direto com URL assinada), texto extraído de PDF/DOCX/texto e indexado para o RAG; imagens vão para a visão.
- **Busca web** com fontes, **geração de imagem** (galeria), **ditado**, **leitura em voz alta** e **modo voz** em tempo real.
- **Busca** no histórico (texto + semântica) e **backups** semanais do banco no R2.

## Autenticação

- `POST /auth/login` devolve um JWT. Depois de 5 senhas erradas, o IP (ou o prefixo IPv6 /64) fica bloqueado por um tempo que dobra a cada nova falha, até 24 h. O bloqueio fica no banco e sobrevive a deploys.
- Há também um teto global de tentativas por minuto (`LOGIN_GLOBAL_MAX_PER_MINUTE`), para um ataque distribuído não saturar a CPU.
- O token só vale enquanto a senha for a mesma: trocar `APP_PASSWORD_HASH` derruba todas as sessões.
- `POST /auth/logout-all` encerra todas as sessões sem trocar a senha.

## Deploy (Railway)

- `railway.toml` define o build pelo `Dockerfile`, o healthcheck em `/health` e o restart automático.
- A imagem roda como usuário sem privilégios, aplica as migrations e sobe o servidor.
- O Postgres precisa ter **pgvector** e ser **Postgres 17**, a mesma versão do `docker-compose.yml` (D35): use o template de Postgres com pgvector da Railway.
- Ative os **backups** do Postgres na Railway (D39).
- Configure as variáveis do `.env.example`, com `FRONTEND_URL` apontando para a URL da Vercel.
- `TRUST_PROXY`: em produção o padrão confia só nas faixas privadas de onde o proxy da Railway conecta. No primeiro deploy, confira nos logs de login (`ip`) se aparece o seu IP real.
- Previews da Vercel: defina `FRONTEND_URL_PATTERN` com uma regex restrita ao seu projeto.
- `/openapi.json` exige token em produção e `/docs` só existe fora de produção.

## CORS do bucket R2

O navegador envia arquivos direto para o R2, então o bucket precisa liberar as origens do front. Se o token do R2 tiver permissão de admin, `POST /settings/storage-cors` (ou o botão em Configurações) faz isso. Senão, no painel da Cloudflare: **R2 → bucket → Settings → CORS Policy**:

```json
[
  {
    "AllowedOrigins": ["http://localhost:3000", "https://SEU-APP.vercel.app"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```
