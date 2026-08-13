#!/bin/sh
set -eu

install -d -o root -g root -m 700 /run/orbitflow-executor
chmod 711 /var/lib/orbitflow /var/lib/orbitflow/run-workspaces
rm -f "$ORBITFLOW_CODING_EXECUTOR_SOCKET"
exec node /app/bin/orbit-coding-executor.mjs
