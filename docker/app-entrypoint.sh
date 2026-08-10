#!/bin/sh
set -eu

mkdir -p /app/data
chown -R node:node /app/data

exec su node -s /bin/sh -c 'exec "$@"' orbitflow-app-entrypoint "$@"
