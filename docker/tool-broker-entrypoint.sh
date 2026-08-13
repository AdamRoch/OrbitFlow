#!/bin/sh
set -eu

install -d -o root -g orbitflow-broker-client -m 770 /run/orbitflow-broker
install -d -o root -g root -m 700 /run/orbitflow-executor
rm -f "$ORBITFLOW_TOOL_BROKER_SOCKET"
exec node /app/bin/orbit-tool-broker.mjs
