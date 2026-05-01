# Spike image: minimal Node + codex CLI + bridge.
# Tagged container for Cloudflare Containers; not intended for production use.

FROM node:20-slim

# codex CLI is distributed as @openai/codex on npm; pinned to match the
# version validated by the local engine on 2026-05-01.
RUN npm install -g @openai/codex@0.128.0 \
    && codex --version \
    && mkdir -p /data/codex-home /data/workspace

WORKDIR /app
COPY container/server.mjs /app/server.mjs

ENV PORT=8080 \
    CODEX_HOME=/data/codex-home \
    WORKSPACE=/data/workspace \
    CODEX_BIN=codex

EXPOSE 8080

# Bridge runs as PID 1; codex is spawned per request (spike v0).
CMD ["node", "/app/server.mjs"]
