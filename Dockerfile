# Railway passes its service name as a Docker build argument. Matching service
# and stage names lets every service build from this one reviewed Dockerfile.
ARG RAILWAY_SERVICE_NAME=web

FROM ghcr.io/openclaw/openclaw:2026.4.15 AS openclaw-base

FROM node:22.22.2-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . ./
RUN npm run build && npm prune --omit=dev

FROM node:22.22.2-bookworm-slim AS app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

WORKDIR /app

COPY --from=build --chown=node:node /app ./
COPY --chown=root:root docker/app-entrypoint.sh /usr/local/bin/orbitflow-app-entrypoint
COPY --chown=root:root docker/coding-adapter-entrypoint.sh /usr/local/bin/orbitflow-coding-adapter-entrypoint
COPY --chown=root:root docker/engine-entrypoint.sh /usr/local/bin/orbitflow-engine-entrypoint
COPY --chown=root:root docker/tool-broker-entrypoint.sh /usr/local/bin/orbitflow-tool-broker-entrypoint
COPY --chown=root:root docker/coding-executor-entrypoint.sh /usr/local/bin/orbitflow-coding-executor-entrypoint
COPY --chown=root:root docker/platform-entrypoint.sh /usr/local/bin/orbitflow-platform-entrypoint

RUN chmod 755 /usr/local/bin/orbitflow-app-entrypoint /usr/local/bin/orbitflow-coding-adapter-entrypoint /usr/local/bin/orbitflow-engine-entrypoint /usr/local/bin/orbitflow-tool-broker-entrypoint /usr/local/bin/orbitflow-coding-executor-entrypoint /usr/local/bin/orbitflow-platform-entrypoint

ENTRYPOINT ["/usr/local/bin/orbitflow-app-entrypoint"]
CMD ["npm", "run", "start"]

FROM app AS engine

USER root

RUN apt-get update \
    && apt-get install --no-install-recommends --yes git \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 19000 orbitflow-broker-client \
    && usermod --append --groups orbitflow-broker-client node

RUN npm ci --prefix coding-adapter --omit=dev

COPY --from=openclaw-base /app /opt/openclaw

RUN chmod 755 /app/scripts/fact-7-fake-opencode.mjs
RUN chmod 755 /app/scripts/fact-34-isolation-opencode.mjs
RUN chown root:root /app/bin/orbit-agent-tools.mjs /app/bin/orbit-coding-tool.mjs /app/bin/orbit-openclaw-tool.mjs /app/bin/orbit-tool-broker.mjs /app/bin/orbit-coding-executor.mjs \
    && chmod 750 /app/bin/orbit-agent-tools.mjs /app/bin/orbit-coding-tool.mjs /app/bin/orbit-tool-broker.mjs /app/bin/orbit-coding-executor.mjs \
    && chmod 755 /app/bin/orbit-openclaw-tool.mjs
RUN install -d -o node -g node -m 700 /var/lib/orbitflow

ENV PATH=/app/coding-adapter/node_modules/.bin:$PATH

ENTRYPOINT ["/usr/local/bin/orbitflow-engine-entrypoint"]
CMD ["node", "--experimental-strip-types", "src/runtime/engine.ts"]

FROM engine AS openclaw-gateway

# Copying only OpenClaw's /app tree omits the official image's Python runtime.
# Its pinned safe-file writer imports Python's secrets module for agent updates.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes python3 \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node docker/openclaw/openclaw.json /opt/orbitflow/openclaw.json
COPY --chown=node:node docker/openclaw/exec-approvals.json /opt/orbitflow/exec-approvals.json
COPY --chown=node:node docker/openclaw/apply-config.mjs /opt/orbitflow/apply-config.mjs
COPY --chown=root:root docker/openclaw/entrypoint.sh /usr/local/bin/orbitflow-openclaw-gateway
COPY --chown=root:root docker/openclaw/healthcheck.sh /usr/local/bin/orbitflow-openclaw-healthcheck

RUN chmod 755 /usr/local/bin/orbitflow-openclaw-gateway /usr/local/bin/orbitflow-openclaw-healthcheck

ENTRYPOINT ["/usr/local/bin/orbitflow-openclaw-gateway"]
CMD []

FROM engine AS tool-broker

ENTRYPOINT ["/usr/local/bin/orbitflow-tool-broker-entrypoint"]
CMD []

FROM engine AS coding-executor

ENTRYPOINT ["/usr/local/bin/orbitflow-coding-executor-entrypoint"]
CMD []

FROM app AS web

FROM engine AS platform

ENTRYPOINT ["/usr/local/bin/orbitflow-platform-entrypoint"]
CMD []

FROM openclaw-gateway AS openclaw-runtime

FROM app AS telegram

CMD ["node", "--experimental-strip-types", "src/runtime/telegram.ts"]

FROM app AS migrate

CMD ["npm", "run", "db:migrate"]

FROM ${RAILWAY_SERVICE_NAME} AS railway-service
