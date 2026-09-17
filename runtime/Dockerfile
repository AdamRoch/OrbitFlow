FROM node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2

ARG OPENCODE_VERSION=1.18.29
ARG RIPGREP_VERSION=13.0.0-4+b2

RUN apt-get update \
    && apt-get install --yes --no-install-recommends "ripgrep=${RIPGREP_VERSION}" \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --omit=dev "opencode-ai@${OPENCODE_VERSION}" \
    && mkdir -p /opt/orbitflow-runtime-home/config/opencode \
    && printf '{"dependencies":{"@opencode-ai/plugin":"%s"}}\n' "${OPENCODE_VERSION}" \
      > /opt/orbitflow-runtime-home/config/opencode/package.json \
    && cd /opt/orbitflow-runtime-home/config/opencode \
    && npm install --omit=dev --ignore-scripts --no-audit --no-fund \
    && printf 'node_modules\npackage-lock.json\n' \
      > /opt/orbitflow-runtime-home/config/opencode/.gitignore \
    && npm cache clean --force

ENV HOME=/tmp/orbitflow-runtime-home \
    XDG_CONFIG_HOME=/opt/orbitflow-runtime-home/config \
    XDG_DATA_HOME=/tmp/orbitflow-runtime-home/data \
    XDG_CACHE_HOME=/tmp/orbitflow-runtime-home/cache \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=true \
    OPENCODE_DISABLE_LSP_DOWNLOAD=true \
    OPENCODE_DISABLE_MODELS_FETCH=true \
    OPENCODE_DISABLE_CLAUDE_CODE=true \
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=true \
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=true

WORKDIR /workspace
EXPOSE 4096

ENTRYPOINT ["opencode", "--pure", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
