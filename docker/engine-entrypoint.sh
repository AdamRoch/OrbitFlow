#!/bin/sh
set -eu

token_file=/run/openclaw-state/gateway-token
if [ ! -s "$token_file" ]; then
  echo "OpenClaw gateway token is unavailable" >&2
  exit 1
fi

export OPENCLAW_GATEWAY_TOKEN="$(cat "$token_file")"
exec "$@"
