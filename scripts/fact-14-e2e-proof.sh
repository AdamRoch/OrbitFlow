#!/usr/bin/env bash
set -euo pipefail

container_name="orbitfactory-fact14-postgres-proof"
database_name="orbitfactory_fact14_proof"
database_user="orbitfactory"
database_password="fact14-local-proof"
created_container="false"
pending_dir=""

cleanup() {
  test_status=$?
  cleanup_failed="false"
  trap - EXIT

  if [[ "$created_container" == "true" ]]; then
    if ! docker rm --force "$container_name"; then
      echo "Failed to remove disposable container: $container_name" >&2
      cleanup_failed="true"
    fi
    if docker container inspect "$container_name" >/dev/null 2>&1; then
      echo "Disposable container still exists after cleanup: $container_name" >&2
      cleanup_failed="true"
    fi
  fi

  if [[ "$test_status" -ne 0 ]]; then
    exit "$test_status"
  fi
  if [[ "$cleanup_failed" == "true" ]]; then
    exit 1
  fi
  exit 0
}
trap cleanup EXIT

if ! command -v openclaw &> /dev/null; then
  echo "openclaw CLI is required" >&2
  exit 1
fi

openclaw_version="$(openclaw --version)"
if [[ "$openclaw_version" != *"2026.4.15"* ]]; then
  echo "OpenClaw 2026.4.15 required; observed: $openclaw_version" >&2
  exit 1
fi
echo "OpenClaw 2026.4.15 confirmed"

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "OPENROUTER_API_KEY is required" >&2
  exit 1
fi

export ORBITFLOW_WORKSPACE_ROOT="${ORBITFLOW_WORKSPACE_ROOT:-$(mktemp -d /tmp/orbitflow-fact14-workspaces.XXXXXX)}"
mkdir -p "$ORBITFLOW_WORKSPACE_ROOT"

pending_dir="$(mktemp -d /tmp/orbitflow-fact14-evidence.XXXXXX)"
export ORBITFLOW_FACT14_PENDING_DIR="$pending_dir"

if docker container inspect "$container_name" >/dev/null 2>&1; then
  echo "Refusing to touch existing container: $container_name" >&2
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
created_container="true"

for _ in {1..30}; do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container_name")"
  if [[ "$health" == "healthy" ]]; then break; fi
  if [[ "$health" == "unhealthy" ]]; then echo "PostgreSQL unhealthy" >&2; exit 1; fi
  sleep 1
done

if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container_name")" != "healthy" ]]; then
  echo "PostgreSQL did not become healthy" >&2
  exit 1
fi

host_port="$(docker port "$container_name" 5432/tcp | sed 's/.*://')"
export DATABASE_URL="postgresql://$database_user:$database_password@127.0.0.1:$host_port/$database_name"
export ORBITFACTORY_FACT14_PROOF_DATABASE="$database_name"

export ORBITFLOW_FACT14_GATEWAY_PORT=18794

echo "=== FACT-14 E2E proof ==="
echo "DB: $host_port  GW: $ORBITFLOW_FACT14_GATEWAY_PORT  Evidence: $pending_dir"
echo ""

node --experimental-strip-types --test scripts/fact-14-e2e-proof.mjs
