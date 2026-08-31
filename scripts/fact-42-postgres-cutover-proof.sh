#!/usr/bin/env bash
set -euo pipefail

container_name="orbitflow-fact42-postgres-proof"
database_name="orbitflow_fact42_proof"
database_user="orbitflow"
database_password="fact42-local-proof"
created_container="false"

cleanup() {
  status=$?
  trap - EXIT
  if [[ "$created_container" == "true" ]]; then
    docker rm --force "$container_name" >/dev/null
    docker container inspect "$container_name" >/dev/null 2>&1 && status=1
  fi
  exit "$status"
}
trap cleanup EXIT

if docker container inspect "$container_name" >/dev/null 2>&1; then
  echo "Refusing to touch existing container: $container_name" >&2
  exit 1
fi

docker run --detach --rm --name "$container_name" \
  --env "POSTGRES_DB=$database_name" \
  --env "POSTGRES_USER=$database_user" \
  --env "POSTGRES_PASSWORD=$database_password" \
  --health-cmd "pg_isready -U $database_user -d $database_name" \
  --health-interval 1s --health-timeout 3s --health-retries 30 \
  --publish 127.0.0.1::5432 postgres:16-alpine >/dev/null
created_container="true"

for _ in {1..30}; do
  [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container_name")" == "healthy" ]] && break
  sleep 1
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$container_name")" == "healthy" ]]

host_port="$(docker port "$container_name" 5432/tcp | sed 's/.*://')"
export DATABASE_URL="postgresql://$database_user:$database_password@127.0.0.1:$host_port/$database_name"
export ORBITFLOW_FACT42_PROOF_DATABASE="$database_name"
export ORBITFACTORY_FACT6_PROOF_DATABASE="$database_name"
export ORBITFACTORY_FACT18_PROOF_DATABASE="$database_name"
export ORBITFACTORY_FACT41_PROOF_DATABASE="$database_name"

reset_database() {
  docker exec "$container_name" dropdb -U "$database_user" "$database_name"
  docker exec "$container_name" createdb -U "$database_user" "$database_name"
}

node test/postgres/schema-standalone.mjs
reset_database
node --test test/postgres/fact-42-schema-readiness.test.mjs
reset_database
node --test test/postgres/state-stream.test.mjs
reset_database
node --experimental-strip-types --test test/postgres/fact-41-ticket-dispatch.test.mjs
reset_database
./node_modules/.bin/tsx --test test/postgres/fact-42-monitoring.test.mjs
