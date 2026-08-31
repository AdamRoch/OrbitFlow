#!/usr/bin/env bash
set -euo pipefail

project="orbitfactory-fact31-proof-$$"
env_file="$(mktemp "${TMPDIR:-/tmp}/orbitfactory-fact31-env.XXXXXX")"
started=false

cleanup() {
  local status=$?
  local image_ids
  trap - EXIT
  if [[ "$started" == true ]]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || status=1
  fi
  rm -f "$env_file"
  for type in container network volume; do
    if [[ -n "$(docker "$type" ls -q --filter "label=com.docker.compose.project=$project")" ]]; then
      echo "FACT-31 proof left a $type for $project" >&2
      status=1
    fi
  done
  image_ids="$(docker image ls -aq --filter "label=com.docker.compose.project=$project" | sort -u)"
  if [[ -n "$image_ids" ]]; then
    docker image rm $image_ids >/dev/null 2>&1 || status=1
  fi
  if [[ -n "$(docker image ls -q --filter "label=com.docker.compose.project=$project")" ]]; then
    echo "FACT-31 proof left an image for $project" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT

printf '%s\n' \
  'POSTGRES_DB=orbitfactory_fact31_proof' \
  'POSTGRES_USER=orbitfactory' \
  'POSTGRES_PASSWORD=fact31-local-proof' \
  'OPENROUTER_API_KEY=not-a-real-key-no-provider-call' \
  >"$env_file"

compose() {
  env -i PATH="$PATH" HOME="${HOME:?HOME is required}" \
    docker compose --project-name "$project" --env-file "$env_file" \
      -f compose.yaml -f docker/fact31-compose-proof.compose.yaml "$@"
}

resolve_loopback_origin() {
  local service="$1"
  local container_port="$2"
  local endpoint
  local host_port

  endpoint="$(compose port "$service" "$container_port")"
  if [[ "$endpoint" =~ ^127\.0\.0\.1:([1-9][0-9]{0,4})$ ]]; then
    host_port="${BASH_REMATCH[1]}"
    if (( 10#$host_port <= 65535 )); then
      printf 'http://127.0.0.1:%s' "$host_port"
      return 0
    fi
  fi

  printf 'FACT-31 proof expected %s:%s to publish on a valid 127.0.0.1 port, got %q\n' \
    "$service" "$container_port" "$endpoint" >&2
  return 1
}

wait_for_snapshot() {
  local predicate="$1"
  local snapshot
  for _ in {1..240}; do
    snapshot="$(compose exec -T engine node --experimental-strip-types scripts/fact-31-compose-fixture.mjs snapshot)"
    if node -e "const value=JSON.parse(process.argv[1]); if (!($predicate)) process.exit(1)" "$snapshot"; then
      printf '%s' "$snapshot"
      return 0
    fi
    sleep 0.25
  done
  echo "Timed out waiting for FACT-31 state: $snapshot" >&2
  return 1
}

started=true
compose up --detach --build --wait --wait-timeout 300

app_origin="$(resolve_loopback_origin app 3000)"
engine_origin="$(resolve_loopback_origin engine 3001)"

readiness="$(node -e "fetch('$engine_origin/readyz').then(async r=>{const b=await r.json();if(!r.ok)process.exit(1);process.stdout.write(JSON.stringify(b))})")"
node -e 'const value=JSON.parse(process.argv[1]); if(value.status!=="ready"||value.workflowEngine!=="operational")process.exit(1)' "$readiness"

required_migration="$(compose exec -T postgres psql -U orbitfactory -d orbitfactory_fact31_proof -Atc "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")"
required_checksum="$(compose exec -T postgres psql -U orbitfactory -d orbitfactory_fact31_proof -Atc "SELECT checksum FROM schema_migrations WHERE version = '$required_migration'")"
compose exec -T postgres psql -U orbitfactory -d orbitfactory_fact31_proof -c "UPDATE schema_migrations SET checksum = 'stale-proof-checksum' WHERE version = '$required_migration'" >/dev/null
node -e "Promise.all([fetch('$app_origin/api/health'), fetch('$engine_origin/readyz')]).then((responses) => { if (responses.some((response) => response.status !== 503)) process.exit(1); })"
compose exec -T postgres psql -U orbitfactory -d orbitfactory_fact31_proof -c "UPDATE schema_migrations SET checksum = '$required_checksum' WHERE version = '$required_migration'" >/dev/null
node -e "Promise.all([fetch('$app_origin/api/health'), fetch('$engine_origin/readyz')]).then((responses) => { if (responses.some((response) => !response.ok)) process.exit(1); })"

compose exec -T engine node --experimental-strip-types scripts/fact-31-compose-fixture.mjs seed >/dev/null
manual="$(wait_for_snapshot 'value.completed_runs === 1 && value.completed_dispatches === 1 && value.materialized_tickets === 1 && value.pending_messages === 0')"
node -e 'const value=JSON.parse(process.argv[1]); if(value.invocations!==1)process.exit(1)' "$manual"

compose restart engine >/dev/null
compose up --detach --wait --wait-timeout 120 engine >/dev/null
after_restart="$(wait_for_snapshot 'value.completed_runs === 1 && value.completed_dispatches === 1 && value.invocations === 1')"
node -e 'const before=JSON.parse(process.argv[1]);const after=JSON.parse(process.argv[2]);if(JSON.stringify(before)!==JSON.stringify(after))process.exit(1)' "$manual" "$after_restart"

trigger="$(compose exec -T engine node --experimental-strip-types scripts/fact-31-compose-fixture.mjs trigger)"
node -e 'const value=JSON.parse(process.argv[1]);if(value.first.kind!=="created"||value.duplicate.kind!=="duplicate"||value.first.runId!==value.duplicate.runId)process.exit(1)' "$trigger"
scheduled="$(wait_for_snapshot 'value.completed_runs === 2 && value.completed_dispatches === 2 && value.invocations === 2 && value.schedule_ticks === 1 && value.pending_messages === 0')"

compose restart engine >/dev/null
compose up --detach --wait --wait-timeout 120 engine >/dev/null
final="$(wait_for_snapshot 'value.completed_runs === 2 && value.completed_dispatches === 2 && value.invocations === 2 && value.schedule_ticks === 1')"
node -e 'const before=JSON.parse(process.argv[1]);const after=JSON.parse(process.argv[2]);if(JSON.stringify(before)!==JSON.stringify(after))process.exit(1)' "$scheduled" "$final"

echo "FACT-31 production engine Compose proof passed for $project"
