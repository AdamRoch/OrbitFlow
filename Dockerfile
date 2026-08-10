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

RUN chmod 755 /usr/local/bin/orbitflow-app-entrypoint /usr/local/bin/orbitflow-coding-adapter-entrypoint

ENTRYPOINT ["/usr/local/bin/orbitflow-app-entrypoint"]
CMD ["npm", "run", "start"]

FROM app AS engine

USER root

RUN apt-get update \
    && apt-get install --no-install-recommends --yes git \
    && rm -rf /var/lib/apt/lists/*

RUN npm ci --prefix coding-adapter --omit=dev

RUN chmod 755 /app/scripts/fact-7-fake-opencode.mjs

ENV PATH=/app/coding-adapter/node_modules/.bin:$PATH

CMD ["node", "scripts/engine-readiness.mjs"]
