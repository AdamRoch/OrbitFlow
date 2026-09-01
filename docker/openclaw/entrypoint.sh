#!/bin/sh
set -eu

state_dir=${OPENCLAW_STATE_DIR:-/home/node/.openclaw}
mkdir -p "$state_dir"
chown -R node:node "$state_dir"
runtime_root=${ORBITFLOW_RUNTIME_ROOT:-/var/lib/orbitflow/runtime}
mkdir -p "$runtime_root"
chown -R node:node "$runtime_root"

node /opt/orbitflow/apply-config.mjs "$state_dir/openclaw.json" /opt/orbitflow/openclaw.json
chown node:node "$state_dir/openclaw.json"
install -o node -g node -m 600 /opt/orbitflow/exec-approvals.json "$state_dir/exec-approvals.json"

token_file="$state_dir/gateway-token"
if [ ! -s "$token_file" ]; then
  umask 077
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' >"$token_file"
  chown node:node "$token_file"
fi

export OPENCLAW_GATEWAY_TOKEN="$(cat "$token_file")"
export OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
export OPENCLAW_STATE_DIR="$state_dir"

gateway_pid=""
rpc_pid=""
shutdown() {
  [ -z "$rpc_pid" ] || kill "$rpc_pid" 2>/dev/null || true
  [ -z "$gateway_pid" ] || kill "$gateway_pid" 2>/dev/null || true
  wait "$rpc_pid" 2>/dev/null || true
  wait "$gateway_pid" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

su node -s /bin/sh -c 'exec node /opt/openclaw/openclaw.mjs gateway --allow-unconfigured --bind lan --auth token --port 18789' &
gateway_pid=$!
su node -s /bin/sh -c 'exec node --experimental-strip-types /app/src/runtime/openclaw-rpc.ts' &
rpc_pid=$!
while kill -0 "$gateway_pid" 2>/dev/null && kill -0 "$rpc_pid" 2>/dev/null; do
  sleep 1
done
exit 1
