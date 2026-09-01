#!/bin/sh
set -eu

exec node -e \
  "fetch('http://127.0.0.1:${ORBITFLOW_RUNTIME_RPC_PORT:-3004}/readyz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
