# cryer — Discord notifications + decisions (TypeScript on Bun).
# Immutable image; local development uses compose.dev.yaml with a bind mount instead.
# Secrets never enter the image: the app loads /app/.env (bind-mount it read-only).
# A private CA is not baked in either: mount the PEM at runtime and point NODE_EXTRA_CA_CERTS at it.
FROM oven/bun:1.4.3-slim

LABEL org.opencontainers.image.title="cryer" \
      org.opencontainers.image.description="Discord notifications and decisions for your services: embeds, prompts with buttons, reactions and replies, over HTTP, MCP or a CLI" \
      org.opencontainers.image.source="https://github.com/rojosinalma/cryer" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

WORKDIR /app

# Dependencies first so the layer is cached across source changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/

# bun:sqlite data dir for single-replica installs (mount a volume here); owned by the runtime user.
RUN mkdir -p /app/data && chown bun:bun /app/data

# The image ships a `bun` user (uid 1000); nothing here needs root.
USER bun

ENV PORT=7474 \
    DATA_DIR=/app/data \
    NODE_ENV=production

EXPOSE 7474

# curl-less probe: the slim image has no curl/wget, bun's fetch does the job.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:7474/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["bun", "run", "src/index.ts"]
