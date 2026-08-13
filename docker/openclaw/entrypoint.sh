#!/bin/sh
set -eu

state_dir=/home/node/.openclaw
mkdir -p "$state_dir"
chown -R node:node "$state_dir"
install -d -o node -g node -m 700 /var/lib/orbitflow/run-workspaces
install -d -o node -g node -m 700 /run/orbitflow

node /opt/orbitflow/apply-config.mjs "$state_dir/openclaw.json" /opt/orbitflow/openclaw.json
chown node:node "$state_dir/openclaw.json"
install -o node -g node -m 600 /opt/orbitflow/exec-approvals.json "$state_dir/exec-approvals.json"
su node -s /bin/sh -c 'exec node /opt/orbitflow/write-tool-env.mjs /run/orbitflow/tool-env.json'

token_file="$state_dir/gateway-token"
if [ ! -s "$token_file" ]; then
  umask 077
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' >"$token_file"
  chown node:node "$token_file"
fi

export OPENCLAW_GATEWAY_TOKEN="$(cat "$token_file")"
exec su node -s /bin/sh -c 'exec node /opt/openclaw/openclaw.mjs gateway --allow-unconfigured --bind lan --auth token --port 18789'
