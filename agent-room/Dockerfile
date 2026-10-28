# syntax=docker/dockerfile:1
# Agent Room: Node app + the two agent CLIs, pinned so the image behaves the same tomorrow.
ARG NODE_IMAGE=node:24-bookworm-slim

# ---- Stage 1: install with npm (npm itself doesn't ship in the final image) ----
FROM ${NODE_IMAGE} AS deps
ARG CLAUDE_CODE_VERSION=2.1.229
ARG CODEX_VERSION=0.165.0

RUN npm install -g --no-fund --no-audit \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @openai/codex@${CODEX_VERSION} \
 # Codex bundles voice and "code mode" helpers (~115 MB) that a text-only room never runs.
 && find /usr/local/lib/node_modules/@openai -type d -path '*/codex-resources/voice' -prune -exec rm -rf {} + \
 && find /usr/local/lib/node_modules/@openai -type f -name 'codex-code-mode-host' -delete

# Browser libraries (exact versions from package-lock.json; dev-only tools are skipped).
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit

# ---- Stage 2: runtime ----
FROM ${NODE_IMAGE}

LABEL org.opencontainers.image.title="Agent Room" \
      org.opencontainers.image.description="Brainstorm with Claude and Codex in one shared conversation" \
      org.opencontainers.image.source="https://github.com/Iqbal-ghazali/demo-apps"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn*

COPY --from=deps /usr/local/lib/node_modules/@anthropic-ai /usr/local/lib/node_modules/@anthropic-ai
COPY --from=deps /usr/local/lib/node_modules/@openai /usr/local/lib/node_modules/@openai
RUN ln -s ../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe /usr/local/bin/claude \
 && ln -s ../lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CODEX_HOME=/home/node/.codex \
    DATA_DIR=/app/data \
    DISABLE_AUTOUPDATER=1

WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /home/node/.codex /app/data && chown -R node:node /home/node/.codex /app/data

# Never run the agents as root.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "server.js"]
