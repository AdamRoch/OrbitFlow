#!/usr/bin/env bash
set -euo pipefail

container_name="orbitfactory-fact34-postgres-proof-$$"
database_name="orbitfactory_fact34_proof"
database_user="orbitfactory"
database_password="fact34-local-proof"
created_container=false

cleanup() {
  proof_status=$?
  trap - EXIT
  if [[ "$created_container" == true ]]; then
    docker rm --force "$container_name" >/dev/null || proof_status=1
  fi
  if docker container inspect "$container_name" >/dev/null 2>&1; then
    printf 'FACT-34 proof left container %s\n' "$container_name" >&2
    proof_status=1
  fi
  exit "$proof_status"
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
export ORBITFACTORY_FACT34_PROOF_DATABASE="$database_name"

node --experimental-strip-types --test test/postgres/fact-34-demo.test.mjs
