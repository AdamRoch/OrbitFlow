#!/bin/sh
set -eu

token_file=/run/openclaw-state/gateway-token
if [ ! -s "$token_file" ]; then
  echo "OpenClaw gateway token is unavailable" >&2
  exit 1
fi

export OPENCLAW_GATEWAY_TOKEN="$(cat "$token_file")"
install -d -o node -g node -m 700 \
  /var/lib/orbitflow/runtime \
  /var/lib/orbitflow/runtime/state \
  /var/lib/orbitflow/runtime/workspaces \
  /var/lib/orbitflow/run-workspaces
exec su node -s /bin/sh -c 'exec "$@"' -- orbitflow-engine "$@"
