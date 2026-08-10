#!/usr/bin/env bash
set -euo pipefail

container_name="orbitfactory-fact13-postgres-proof"
database_name="orbitfactory_fact13_proof"
upgrade_database_name="orbitfactory_fact13_upgrade_proof"
database_user="orbitfactory"
database_password="fact13-local-proof"
created_container="false"

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
  if [[ "$test_status" -ne 0 ]]; then exit "$test_status"; fi
  if [[ "$cleanup_failed" == "true" ]]; then exit 1; fi
}
trap cleanup EXIT

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
  --health-interval 1s --health-timeout 3s --health-retries 30 \
  --publish 127.0.0.1::5432 postgres:16-alpine >/dev/null
created_container="true"

for _ in {1..30}; do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container_name")"
  [[ "$health" == "healthy" ]] && break
  [[ "$health" == "unhealthy" ]] && { echo "Disposable PostgreSQL container became unhealthy" >&2; exit 1; }
  sleep 1
done

if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container_name")" != "healthy" ]]; then
  echo "Disposable PostgreSQL container did not become healthy" >&2
  exit 1
fi

host_port="$(docker port "$container_name" 5432/tcp | sed 's/.*://')"
export DATABASE_URL="postgresql://$database_user:$database_password@127.0.0.1:$host_port/$database_name"
export ORBITFACTORY_FACT13_PROOF_DATABASE="$database_name"
docker exec "$container_name" createdb --username "$database_user" "$upgrade_database_name"
export ORBITFACTORY_FACT13_UPGRADE_DATABASE="$upgrade_database_name"
export ORBITFACTORY_FACT13_UPGRADE_DATABASE_URL="postgresql://$database_user:$database_password@127.0.0.1:$host_port/$upgrade_database_name"
node --test test/postgres/platform-tool-upgrade.test.mjs
node --experimental-strip-types --test test/postgres/platform-tool.test.mjs
