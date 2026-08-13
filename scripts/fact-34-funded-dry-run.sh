#!/usr/bin/env bash
set -euo pipefail

attempt="${1:-}"
if [[ "$attempt" != 1 && "$attempt" != 2 ]]; then
  printf '%s\n' 'usage: scripts/fact-34-funded-dry-run.sh <1|2>' >&2
  exit 2
fi
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  printf '%s\n' 'OPENROUTER_API_KEY is required' >&2
  exit 1
fi
if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  printf '%s\n' 'FACT-34 funded dry runs use the established local Telegram boundary, not a live token' >&2
  exit 1
fi

evidence_directory="evidence/fact-34/funded-run-$attempt"
if [[ -e "$evidence_directory" ]]; then
  printf 'Refusing to reuse funded attempt evidence: %s\n' "$evidence_directory" >&2
  exit 1
fi
mkdir -p "$evidence_directory/structured"

container_name="orbitfactory-fact34-funded-$attempt-$$"
database_name="orbitfactory_fact34_funded_$attempt"
database_user="orbitfactory"
database_password="fact34-funded-local-$attempt"
runtime_root="$(mktemp -d "${TMPDIR:-/tmp}/orbitflow-fact34-runtime-$attempt.XXXXXX")"
workspace_root="$(mktemp -d "${TMPDIR:-/tmp}/orbitflow-fact34-workspaces-$attempt.XXXXXX")"
gateway_port="$((18830 + attempt))"
created_container=false

cleanup() {
  run_status=$?
  trap - EXIT
  if [[ "$created_container" == true ]]; then
    docker rm --force "$container_name" >/dev/null || run_status=1
  fi
  if docker container inspect "$container_name" >/dev/null 2>&1; then
    printf 'Funded run left container %s\n' "$container_name" >&2
    run_status=1
  fi
  rm -rf "$runtime_root" "$workspace_root"
  exit "$run_status"
}
trap cleanup EXIT

if docker container inspect "$container_name" >/dev/null 2>&1; then
  printf 'Refusing to touch existing container %s\n' "$container_name" >&2
  exit 1
fi

docker run --detach --rm \
  --name "$container_name" \
  --env "POSTGRES_DB=$database_name" \
  --env "POSTGRES_USER=$database_user" \
  --env "POSTGRES_PASSWORD=$database_password" \
  --health-cmd "pg_isready -U $database_user -d $database_name" \
  --health-interval 1s \
  --health-timeout 3s \
  --health-retries 30 \
  --publish 127.0.0.1::5432 \
  postgres:16-alpine >/dev/null
created_container=true
for _ in {1..30}; do
  [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container_name")" == healthy ]] && break
  sleep 1
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$container_name")" == healthy ]]

host_port="$(docker port "$container_name" 5432/tcp | sed 's/.*://')"
export DATABASE_URL="postgresql://$database_user:$database_password@127.0.0.1:$host_port/$database_name"
export ORBITFLOW_FACT34_ATTEMPT="$attempt"
export ORBITFLOW_FACT34_EVIDENCE_DIR="$PWD/$evidence_directory"
export ORBITFLOW_FACT34_RUNTIME_ROOT="$runtime_root"
export ORBITFLOW_FACT34_GATEWAY_PORT="$gateway_port"
export ORBITFLOW_WORKSPACE_ROOT="$workspace_root"

{
  printf 'boundary=fact-34-funded-dry-run\n'
  printf 'model=openrouter/moonshotai/kimi-k3\n'
  printf 'attempt=%s-of-2\n' "$attempt"
  printf 'head=%s\n' "$(git rev-parse HEAD)"
  printf 'started_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$evidence_directory/provider-proof.log"

set +e
node --experimental-strip-types scripts/fact-34-funded-dry-run.mjs \
  2>&1 | tee -a "$evidence_directory/provider-proof.log"
node_status=${PIPESTATUS[0]}
set -e

printf 'exit_code=%s\n' "$node_status" >>"$evidence_directory/provider-proof.log"
printf 'finished_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$evidence_directory/provider-proof.log"

gitleaks dir --redact --no-banner "$evidence_directory" >"$evidence_directory/secret-scan.log" 2>&1
printf 'exit_code=0\n' >>"$evidence_directory/secret-scan.log"

exit "$node_status"
