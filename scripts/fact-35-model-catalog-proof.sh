#!/usr/bin/env bash
set -euo pipefail

container_name="orbitfactory-fact35-postgres-proof"
fresh_database="orbitfactory_fact35_fresh"
upgrade_database="orbitfactory_fact35_upgrade"
database_user="orbitfactory"
database_password="fact35-local-proof"
created_container="false"

cleanup() {
  proof_status=$?
  trap - EXIT
  if [[ "$created_container" == "true" ]]; then
    docker rm --force "$container_name" >/dev/null
  fi
  exit "$proof_status"
}
trap cleanup EXIT

if docker container inspect "$container_name" >/dev/null 2>&1; then
  echo "Refusing to touch existing container: $container_name" >&2
  exit 1
fi

docker run --detach --rm \
  --name "$container_name" \
  --env "POSTGRES_DB=$fresh_database" \
  --env "POSTGRES_USER=$database_user" \
  --env "POSTGRES_PASSWORD=$database_password" \
  --health-cmd "pg_isready -U $database_user -d $fresh_database" \
  --health-interval 1s --health-timeout 3s --health-retries 30 \
  --publish 127.0.0.1::5432 postgres:16-alpine >/dev/null
created_container="true"

for _ in {1..30}; do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container_name")"
  [[ "$health" == "healthy" ]] && break
  [[ "$health" == "unhealthy" ]] && { echo "Disposable PostgreSQL became unhealthy" >&2; exit 1; }
  sleep 1
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$container_name")" == "healthy" ]]

host_port="$(docker port "$container_name" 5432/tcp | sed 's/.*://')"
docker exec "$container_name" createdb --username "$database_user" "$upgrade_database"
export ORBITFACTORY_FACT35_FRESH_DATABASE_URL="postgresql://$database_user:$database_password@127.0.0.1:$host_port/$fresh_database"
export ORBITFACTORY_FACT35_UPGRADE_DATABASE_URL="postgresql://$database_user:$database_password@127.0.0.1:$host_port/$upgrade_database"

node --test test/openclaw-model-catalog.test.mjs
node --experimental-strip-types --test test/postgres/fact-35-model-catalog.test.mjs
