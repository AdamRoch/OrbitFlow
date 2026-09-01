#!/bin/sh
set -eu

install -d -o root -g root -m 700 /run/orbitflow-executor
exec node /app/bin/orbit-tool-broker.mjs
