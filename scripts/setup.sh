#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo 'Install Node.js 22.12 or newer.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'Start Docker Desktop, then rerun npm run setup.' >&2; exit 1; }
npm ci
docker compose up -d --wait postgres
docker compose exec -T postgres psql -U orbitflow -d postgres -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'CREATE DATABASE orbitflow_v2' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'orbitflow_v2')\gexec
SQL
docker build -t orbitflow-runtime:1.18.29 runtime
npm run build
exec node --env-file-if-exists=.env --import tsx src/server/index.ts
