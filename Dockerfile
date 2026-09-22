# AlertUp backend — Fly.io image.
#
# Debian slim rather than Alpine: Prisma's query engine wants glibc + openssl,
# and the musl builds have been a recurring source of "engine not found" at boot.
# Node 22 matches the local dev version.

# ---- deps -------------------------------------------------------------------
# Kept separate so a source-only change never reinstalls node_modules.
FROM node:22-slim AS deps

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# package.json runs `prisma generate` on postinstall, so the schema has to be
# in place before npm ci — otherwise the install fails looking for it.
COPY package.json package-lock.json ./
COPY prisma ./prisma

RUN npm ci --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-slim AS runtime

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY package.json package-lock.json ./
COPY server.js ./
COPY src ./src

# The `node` user ships with the base image. Running unprivileged means a
# path-traversal bug in the upload routes cannot write outside /app.
USER node

EXPOSE 8080

# Migrations do NOT run here — fly.toml's release_command runs them once per
# deploy instead of once per machine, so two machines can never race each other
# applying the same migration.
CMD ["node", "server.js"]
