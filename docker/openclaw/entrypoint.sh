#!/bin/sh
set -eu

state_dir=/home/node/.openclaw
mkdir -p "$state_dir"
chown -R node:node "$state_dir"

if [ ! -f "$state_dir/openclaw.json" ]; then
  install -o node -g node -m 600 /opt/orbitflow/openclaw.json "$state_dir/openclaw.json"
fi

token_file="$state_dir/gateway-token"
if [ ! -s "$token_file" ]; then
  umask 077
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' >"$token_file"
  chown node:node "$token_file"
fi

export OPENCLAW_GATEWAY_TOKEN="$(cat "$token_file")"
exec su node -s /bin/sh -c 'exec node /app/openclaw.mjs gateway --allow-unconfigured --bind lan --auth token --port 18789'
