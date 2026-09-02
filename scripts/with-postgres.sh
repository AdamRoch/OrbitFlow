#!/usr/bin/env bash
# Runs one command against a disposable PostgreSQL container, then removes it.
#
#   scripts/with-postgres.sh [extra-database ...] -- <command ...>
#
# Exports DATABASE_URL for the database "proof", PROOF_BASE_URL for any extra
# databases created here, and PROOF_CONTAINER for docker exec.
set -euo pipefail

extra=()
while [[ $# -gt 0 && "$1" != "--" ]]; do
  extra+=("$1")
  shift
done
[[ "${1:-}" == "--" ]] && shift
if [[ $# -eq 0 ]]; then
  echo "usage: scripts/with-postgres.sh [extra-database ...] -- <command ...>" >&2
  exit 2
fi

container="orbitflow-proof-$$"
trap 'docker rm --force "$container" >/dev/null 2>&1 || true' EXIT
docker run --detach --rm --name "$container" \
  --env POSTGRES_DB=proof --env POSTGRES_USER=orbitflow --env POSTGRES_PASSWORD=proof \
  --health-cmd "pg_isready -U orbitflow -d proof" \
  --health-interval 1s --health-timeout 3s --health-retries 30 \
  --publish 127.0.0.1::5432 postgres:16-alpine >/dev/null
for _ in {1..30}; do
  [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" == healthy ]] && break
  sleep 1
done
if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" != healthy ]]; then
  echo "disposable PostgreSQL did not become healthy" >&2
  exit 1
fi
for database in ${extra[@]+"${extra[@]}"}; do
  docker exec "$container" createdb -U orbitflow "$database"
done

export PROOF_CONTAINER="$container"
export PROOF_BASE_URL="postgresql://orbitflow:proof@127.0.0.1:$(docker port "$container" 5432/tcp | sed 's/.*://')"
export DATABASE_URL="$PROOF_BASE_URL/proof"
"$@"
