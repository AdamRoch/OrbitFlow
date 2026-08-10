FROM ghcr.io/openclaw/openclaw:2026.4.15

USER root

COPY --chown=node:node docker/openclaw/openclaw.json /opt/orbitflow/openclaw.json
COPY --chown=root:root docker/openclaw/entrypoint.sh /usr/local/bin/orbitflow-openclaw-gateway

RUN chmod 755 /usr/local/bin/orbitflow-openclaw-gateway

ENTRYPOINT ["/usr/local/bin/orbitflow-openclaw-gateway"]
