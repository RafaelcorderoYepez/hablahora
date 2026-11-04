# syntax=docker/dockerfile:1
# Imagen de producción: la API sirve también la consola y el chat compilados.
#   docker build -t hablahora .
#   docker run --env-file .env.production -p 3000:3000 hablahora
# Migraciones (antes de cada despliegue, con DATABASE_ADMIN_URL):
#   docker run --env-file .env.production hablahora node packages/db/dist/cli.js

# ---------- compilar ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
# primero los package.json: la instalación queda en caché mientras no cambien las dependencias
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/
COPY apps/chat/package.json apps/chat/
COPY apps/console/package.json apps/console/
RUN npm ci
COPY . .
RUN npm run build

# ---------- ejecutar ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/
COPY apps/chat/package.json apps/chat/
COPY apps/console/package.json apps/console/
# solo las dependencias de producción de la API (y los paquetes que usa): las apps web ya van compiladas
RUN npm ci --omit=dev --ignore-scripts --workspace @hablahora/api && npm cache clean --force
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/migrations packages/db/migrations
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/console/dist apps/console/dist
COPY --from=build /app/apps/chat/dist apps/chat/dist
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
