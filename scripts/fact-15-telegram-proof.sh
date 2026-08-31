#!/usr/bin/env bash
set -euo pipefail

container_name="orbitfactory-fact15-postgres-proof"
database_name="orbitfactory_fact15_proof"
database_user="orbitfactory"
database_password="fact15-local-proof"
created_container="false"

cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$created_container" == "true" ]]; then
    docker rm --force "$container_name" >/dev/null || exit 1
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
export ORBITFACTORY_FACT15_PROOF_DATABASE="$database_name"
npm run test:telegram

# The service is opt-in so ordinary local Compose remains token-free. This
# validates the production service graph without putting a real bot token in a test.
POSTGRES_DB=orbitfactory_proof \
POSTGRES_USER=orbitfactory \
POSTGRES_PASSWORD=fact15-proof-password \
OPENROUTER_API_KEY=not-a-real-key \
TELEGRAM_BOT_TOKEN=not-a-real-telegram-token \
ORBITFACTORY_APP_PORT=39015 \
ORBITFACTORY_ENGINE_HOST_PORT=40015 \
docker compose --profile telegram config --quiet

echo "FACT-15 Telegram proof passed"
