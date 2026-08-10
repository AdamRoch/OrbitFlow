#!/usr/bin/env bash
set -euo pipefail

project="orbitfactory-fact7-proof-$$"
app_port="$((39000 + ($$ % 1000)))"
engine_port="$((40000 + ($$ % 1000)))"
env_file="$(mktemp "${TMPDIR:-/tmp}/orbitfactory-fact7-env.XXXXXX")"
started="false"

cat >"$env_file" <<EOF
POSTGRES_DB=orbitfactory_proof
POSTGRES_USER=orbitfactory
POSTGRES_PASSWORD=fact7-proof-password
OPENROUTER_API_KEY=not-a-real-key-for-structural-compose-proof
ORBITFACTORY_APP_PORT=$app_port
ORBITFACTORY_ENGINE_PORT=$engine_port
ORBITFACTORY_DB_PATH=/app/data/orbitfactory.db
EOF

compose() {
  docker compose --project-name "$project" --env-file "$env_file" "$@"
}

assert_empty() {
  local resource_type="$1"
  local output
  output="$2"
  if [[ -n "$output" ]]; then
    echo "FACT-7 proof left $resource_type for $project: $output" >&2
    exit 1
  fi
}

cleanup() {
  local status=$?
  trap - EXIT

  if [[ "$started" == "true" ]]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || status=1
  fi

  rm -f "$env_file"
  assert_empty "containers" "$(docker ps -aq --filter "label=com.docker.compose.project=$project")"
  assert_empty "networks" "$(docker network ls -q --filter "label=com.docker.compose.project=$project")"
  assert_empty "volumes" "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"
  exit "$status"
}
trap cleanup EXIT

compose config --quiet
if [[ "${FACT7_BUILD_NO_CACHE:-1}" == "1" ]]; then
  compose build --pull --no-cache
else
  compose build --pull
fi
started="true"
compose up --detach --wait --wait-timeout 240

running_services="$(compose ps --status running --services | sort)"
expected_running=$'app\nengine\nopenclaw\npostgres'
if [[ "$running_services" != "$expected_running" ]]; then
  echo "Unexpected running services: $running_services" >&2
  exit 1
fi

migrate_id="$(compose ps --all --quiet migrate)"
if [[ -z "$migrate_id" ]] || [[ "$(docker inspect --format '{{.State.ExitCode}}' "$migrate_id")" != "0" ]]; then
  echo "Migration service did not complete successfully" >&2
  exit 1
fi

node -e "fetch('http://127.0.0.1:$app_port/api/health').then(async (response) => { const body = await response.json(); if (!response.ok || body.status !== 'ready') process.exit(1); }).catch(() => process.exit(1));"

applied_migrations="$(compose exec -T postgres psql -U orbitfactory -d orbitfactory_proof -Atc "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations")"
if [[ "$applied_migrations" != "0001-control-plane.sql,0002-tickets.sql,0003-message-plane.sql" ]]; then
  echo "Unexpected migration state: $applied_migrations" >&2
  exit 1
fi

compose exec -T openclaw node /app/openclaw.mjs --version | grep -F "2026.4.15" >/dev/null
compose exec -T openclaw node -e "fetch('http://127.0.0.1:18789/readyz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
compose exec -T engine opencode --version | grep -Fx "1.18.4" >/dev/null

no_op_output="$(compose run --rm migrate 2>&1)"
if [[ "$no_op_output" != *"No migrations to apply."* ]]; then
  echo "Migration rerun was not a no-op" >&2
  exit 1
fi

compose restart app engine openclaw postgres
compose up --detach --wait --wait-timeout 120
node -e "fetch('http://127.0.0.1:$app_port/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));"

echo "FACT-7 Compose proof passed for $project"
