#!/usr/bin/env bash
set -euo pipefail

project="orbitfactory-fact7-proof-$$"
failure_project="${project}-dependency-failure"
app_port="$((39000 + ($$ % 1000)))"
engine_host_port="$((40000 + ($$ % 1000)))"
env_file="$(mktemp "${TMPDIR:-/tmp}/orbitfactory-fact7-env.XXXXXX")"
positive_started="false"
failure_started="false"

cat >"$env_file" <<EOF
POSTGRES_DB=orbitfactory_proof
POSTGRES_USER=orbitfactory
POSTGRES_PASSWORD=fact7-proof-password
OPENROUTER_API_KEY=not-a-real-key-for-structural-compose-proof
ORBITFACTORY_APP_PORT=$app_port
ORBITFACTORY_ENGINE_HOST_PORT=$engine_host_port
ORBITFACTORY_DB_PATH=/app/data/orbitfactory.db
EOF

docker_compose() {
  local project_name="$1"
  local interpolation_file="$2"
  shift 2

  # Docker Compose lets the parent shell override --env-file interpolation.
  # Clear it completely, retaining only what the Docker client needs to reach
  # its local socket and the explicit proof environment file.
  env -i PATH="$PATH" HOME="${HOME:?HOME is required}" \
    docker compose --project-name "$project_name" --env-file "$interpolation_file" "$@"
}

compose() {
  docker_compose "$project" "$env_file" "$@"
}

failure_compose() {
  docker_compose "$failure_project" "$env_file" \
    -f compose.yaml -f docker/fact7-migration-failure.compose.yaml "$@"
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

  if [[ "$positive_started" == "true" ]]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || status=1
  fi
  if [[ "$failure_started" == "true" ]]; then
    failure_compose down --volumes --remove-orphans >/dev/null 2>&1 || status=1
  fi

  rm -f "$env_file"
  assert_empty "containers" "$(docker ps -aq --filter "label=com.docker.compose.project=$project")"
  assert_empty "networks" "$(docker network ls -q --filter "label=com.docker.compose.project=$project")"
  assert_empty "volumes" "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"
  assert_empty "dependency-failure containers" "$(docker ps -aq --filter "label=com.docker.compose.project=$failure_project")"
  assert_empty "dependency-failure networks" "$(docker network ls -q --filter "label=com.docker.compose.project=$failure_project")"
  assert_empty "dependency-failure volumes" "$(docker volume ls -q --filter "label=com.docker.compose.project=$failure_project")"
  exit "$status"
}
trap cleanup EXIT

# Prove that no ambient Compose interpolation can override this proof's fake
# configuration. No rendered configuration is printed, so even the dummy value
# remains out of the retained command output.
rendered_config="$(POSTGRES_DB=ambient-compose-value \
  POSTGRES_USER=ambient-compose-value \
  POSTGRES_PASSWORD=ambient-compose-value \
  OPENROUTER_API_KEY=ambient-compose-value \
  ORBITFACTORY_APP_PORT=49999 \
  ORBITFACTORY_ENGINE_HOST_PORT=49998 \
  ORBITFACTORY_DB_PATH=/ambient-compose-value \
  compose config)"
if [[ "$rendered_config" == *"ambient-compose-value"* || "$rendered_config" == *"49999"* || "$rendered_config" == *"49998"* ]]; then
  echo "FACT-7 proof allowed ambient Compose interpolation" >&2
  exit 1
fi
for expected in orbitfactory_proof fact7-proof-password not-a-real-key-for-structural-compose-proof "$app_port" "$engine_host_port" /app/data/orbitfactory.db; do
  if [[ "$rendered_config" != *"$expected"* ]]; then
    echo "FACT-7 proof did not render expected controlled configuration" >&2
    exit 1
  fi
done

compose config --quiet

missing_env_file="$(mktemp "${TMPDIR:-/tmp}/orbitfactory-fact7-missing-env.XXXXXX")"
if docker_compose "$project-missing-config" "$missing_env_file" config --quiet >/dev/null 2>&1; then
  echo "Compose accepted missing required configuration" >&2
  exit 1
fi
rm -f "$missing_env_file"

if [[ "${FACT7_BUILD_NO_CACHE:-1}" == "1" ]]; then
  compose build --pull --no-cache
else
  compose build --pull
fi

# A failed migration is a meaningful readiness failure: app must remain down
# because its service_completed_successfully dependency did not complete.
failure_started="true"
if failure_compose up --detach --wait --wait-timeout 120 app >/dev/null 2>&1; then
  echo "Compose accepted a deliberately failed migration dependency" >&2
  exit 1
fi
failed_migrate_id="$(failure_compose ps --all --quiet migrate)"
if [[ -z "$failed_migrate_id" || "$(docker inspect --format '{{.State.ExitCode}}' "$failed_migrate_id")" != "17" ]]; then
  echo "Deliberately failed migration did not exit with its expected status" >&2
  exit 1
fi
if failure_compose ps --status running --services | grep -Fx app >/dev/null; then
  echo "App started despite its failed migration dependency" >&2
  exit 1
fi
failure_compose down --volumes --remove-orphans >/dev/null
failure_started="false"
assert_empty "dependency-failure containers" "$(docker ps -aq --filter "label=com.docker.compose.project=$failure_project")"
assert_empty "dependency-failure networks" "$(docker network ls -q --filter "label=com.docker.compose.project=$failure_project")"
assert_empty "dependency-failure volumes" "$(docker volume ls -q --filter "label=com.docker.compose.project=$failure_project")"

positive_started="true"
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

assert_app_http() {
  node -e "Promise.all([fetch('http://127.0.0.1:$app_port/api/health').then(async (response) => { const body = await response.json(); if (!response.ok || body.status !== 'ready') throw new Error('health endpoint is not ready'); }), fetch('http://127.0.0.1:$app_port/').then(async (response) => { const body = await response.text(); if (!response.ok || !body.includes('OrbitFactory')) throw new Error('UI is not reachable'); })]).catch((error) => { console.error(error.message); process.exit(1); });"
}

assert_app_http

applied_migrations="$(compose exec -T postgres psql -U orbitfactory -d orbitfactory_proof -Atc "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations")"
if [[ "$applied_migrations" != "0001-control-plane.sql,0002-tickets.sql,0003-message-plane.sql" ]]; then
  echo "Unexpected migration state: $applied_migrations" >&2
  exit 1
fi

compose exec -T openclaw node /app/openclaw.mjs --version | grep -F "2026.4.15" >/dev/null
compose exec -T openclaw node -e "fetch('http://127.0.0.1:18789/readyz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
compose exec -T engine opencode --version | grep -Fx "1.18.4" >/dev/null
compose exec -T engine node -e "if ('OPENROUTER_API_KEY' in process.env) throw new Error('engine readiness process received a provider credential')"
compose exec -T engine node scripts/opencode-structural-proof.mjs | grep -Fx "OpenCode adapter missing-credential contract verified" >/dev/null

no_op_output="$(compose run --rm migrate 2>&1)"
if [[ "$no_op_output" != *"No migrations to apply."* ]]; then
  echo "Migration rerun was not a no-op" >&2
  exit 1
fi

compose restart app engine openclaw postgres
compose up --detach --wait --wait-timeout 120
assert_app_http

echo "FACT-7 Compose proof passed for $project"
