FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
# "::" escuta IPv4 e IPv6 (rede privada da Railway é IPv6).
ENV NODE_ENV=production HOST=::
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node drizzle ./drizzle
USER node
EXPOSE 3333
# exec: o node vira o processo principal e recebe o SIGTERM direto (encerramento limpo).
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/index.js"]
