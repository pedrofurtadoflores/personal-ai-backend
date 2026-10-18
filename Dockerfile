FROM node:26-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:26-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5
WORKDIR /app
# "::" escuta IPv4 e IPv6 (rede privada da Railway é IPv6).
ENV NODE_ENV=production HOST=::
# pg_dump para os backups (D39), na mesma versão major do banco.
RUN apk add --no-cache postgresql17-client
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node drizzle ./drizzle
USER node
EXPOSE 3333
# exec: o node vira o processo principal e recebe o SIGTERM direto (encerramento limpo).
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/index.js"]
