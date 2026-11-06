# syntax=docker/dockerfile:1
# Build from the repository root, not this directory.
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm ci

FROM dependencies AS build
RUN npm run build:api

# Keep tsx, migration sources and SQL out of the API's standalone image.
FROM dependencies AS migrate
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "--import", "/app/deploy/contabo/with-database.mjs"]
CMD ["node_modules/tsx/dist/cli.mjs", "scripts/migrate.ts"]

FROM node:22-bookworm-slim AS genesis-worker
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=96
COPY --chown=node:node scripts/genesis-worker.mjs ./scripts/genesis-worker.mjs
USER node
CMD ["node", "scripts/genesis-worker.mjs", "--watch"]

FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3001
COPY --from=build --chown=node:node /app/apps/api/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/api/.next/static ./apps/api/.next/static
COPY --chown=node:node deploy/contabo/with-database.mjs ./deploy/contabo/with-database.mjs
USER node
EXPOSE 3001
ENTRYPOINT ["node", "--import", "/app/deploy/contabo/with-database.mjs"]
CMD ["apps/api/server.js"]
