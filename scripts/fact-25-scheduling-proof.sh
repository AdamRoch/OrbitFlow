#!/usr/bin/env bash
set -euo pipefail

container_name="orbitfactory-fact25-postgres-proof"
database_name="orbitfactory_fact25_proof"
database_user="orbitfactory"
database_password="fact25-local-proof"
created_container="false"
cleanup() { local status=$?; trap - EXIT; [[ "$created_container" == "true" ]] && docker rm --force "$container_name" >/dev/null; exit "$status"; }
trap cleanup EXIT
if docker container inspect "$container_name" >/dev/null 2>&1; then echo "Refusing to touch existing container: $container_name" >&2; exit 1; fi
docker run --detach --rm --name "$container_name" --env "POSTGRES_DB=$database_name" --env "POSTGRES_USER=$database_user" --env "POSTGRES_PASSWORD=$database_password" --health-cmd "pg_isready -U $database_user -d $database_name" --health-interval 1s --health-timeout 3s --health-retries 30 --publish 127.0.0.1::5432 postgres:16-alpine >/dev/null
created_container="true"
for _ in {1..30}; do [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container_name")" == "healthy" ]] && break; sleep 1; done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$container_name")" == "healthy" ]]
host_port="$(docker port "$container_name" 5432/tcp | sed 's/.*://')"
export DATABASE_URL="postgresql://$database_user:$database_password@127.0.0.1:$host_port/$database_name"
export ORBITFACTORY_FACT25_PROOF_DATABASE="$database_name"
npm run test:scheduling
POSTGRES_DB=orbitfactory_proof POSTGRES_USER=orbitfactory POSTGRES_PASSWORD=fact25-proof-password OPENROUTER_API_KEY=not-a-real-key ORBITFACTORY_APP_PORT=39025 ORBITFACTORY_ENGINE_HOST_PORT=40025 ORBITFACTORY_DB_PATH=/app/data/orbitfactory.db docker compose config --quiet
echo "FACT-25 scheduling proof passed"
