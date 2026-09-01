#!/bin/sh
set -eu

install -d -o node -g node -m 700 \
  /var/lib/orbitflow/runtime \
  /var/lib/orbitflow/runtime/home \
  /var/lib/orbitflow/runtime/state \
  /var/lib/orbitflow/runtime/workspaces \
  /var/lib/orbitflow/run-workspaces

broker_pid=""
engine_pid=""
shutdown() {
  [ -z "$engine_pid" ] || kill "$engine_pid" 2>/dev/null || true
  [ -z "$broker_pid" ] || kill "$broker_pid" 2>/dev/null || true
  wait "$engine_pid" 2>/dev/null || true
  wait "$broker_pid" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

node /app/bin/orbit-tool-broker.mjs &
broker_pid=$!
su node -s /bin/sh -c 'exec node --experimental-strip-types /app/src/runtime/engine.ts' &
engine_pid=$!

while kill -0 "$broker_pid" 2>/dev/null && kill -0 "$engine_pid" 2>/dev/null; do
  sleep 1
done

exit 1
