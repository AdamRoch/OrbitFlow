#!/usr/bin/env bash
set -euo pipefail

container_name="orbitfactory-fact38-postgres-proof-$$"
database_name="orbitfactory_fact38_proof"
database_user="orbitfactory"
database_password="fact38-local-proof"
created_container=false

cleanup() {
  proof_status=$?
  trap - EXIT
  if [[ "$created_container" == true ]]; then
    docker rm --force "$container_name" >/dev/null || proof_status=1
  fi
  if docker container inspect "$container_name" >/dev/null 2>&1; then
    printf 'FACT-38 proof left container %s\n' "$container_name" >&2
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

node --test test/postgres/workspace-export.test.mjs
