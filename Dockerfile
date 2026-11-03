FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
    && rm -rf /var/lib/apt/lists/*

# Pin the OpenCode server version the worker is tested against.
RUN npm install --global @opencode/cli@2.2.5

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src

ENV NODE_ENV=production \
    HOME=/data \
    WORKSPACE=/data/workspace \
    PORT=3000 \
    OPENCODE_PORT=4100

RUN mkdir -p /data/workspace /data/.local/share/opencode /data/.config/opencode \
    && chown -R node:node /data /app

USER node

EXPOSE 3000

# /health is authenticated, so the check sends the worker API key.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS -H "Authorization: Bearer ${API_KEY}" "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server.js"]
