#!/usr/bin/env bash
set -euo pipefail

container_name="orbitfactory-fact11-postgres-proof"
database_name="orbitfactory_fact11_proof"
database_user="orbitfactory"
database_password="fact11-local-proof"
expected_openclaw_version="2026.4.15"
created_container="false"
openclaw_runtime=""

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

  if [[ -n "$openclaw_runtime" ]]; then
    case "$openclaw_runtime" in
      /tmp/orbitflow-fact11-openclaw-cli.*)
        if [[ -d "$openclaw_runtime" ]]; then
          find "$openclaw_runtime" -depth -delete
        fi
        ;;
      *)
        echo "Refusing to clean unexpected OpenClaw proof path: $openclaw_runtime" >&2
        cleanup_failed="true"
        ;;
    esac
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

if [[ "${ORBITFLOW_FACT11_REAL_PROVIDER_PROOF:-0}" != "0" ]]; then
  echo "Real-provider FACT-11 proof is intentionally disabled. The retained proof uses the fake OpenClaw request path." >&2
  exit 2
fi

openclaw_version="$(openclaw --version)"
if [[ "$openclaw_version" != *"$expected_openclaw_version"* ]]; then
  echo "FACT-11 requires OpenClaw $expected_openclaw_version; observed: $openclaw_version" >&2
  exit 1
fi
echo "Exact OpenClaw version present: $expected_openclaw_version"
echo "Provider execution: disabled; deterministic fake request path selected"

openclaw_runtime="$(mktemp -d /tmp/orbitflow-fact11-openclaw-cli.XXXXXX)"
mkdir -p "$openclaw_runtime/workspace"
printf '# Runtime Proof\n\n- Name: Runtime Proof\n- Theme: deterministic runtime proof\n' \
  > "$openclaw_runtime/workspace/IDENTITY.md"

run_openclaw() {
  env -u OPENROUTER_API_KEY \
    OPENCLAW_STATE_DIR="$openclaw_runtime/state" \
    openclaw --no-color "$@"
}

run_openclaw agents add orbitflow-proof \
  --workspace "$openclaw_runtime/workspace" \
  --model openrouter/openai/gpt-4.1-mini \
  --non-interactive --json > "$openclaw_runtime/created.json"
run_openclaw agents list --json > "$openclaw_runtime/listed.json"
run_openclaw config get agents.list --json > "$openclaw_runtime/configured.json"

configured_index="$(node -e '
  const fs = require("node:fs");
  const agents = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const index = agents.findIndex((agent) => agent.id === "orbitflow-proof");
  if (index < 0) process.exit(1);
  process.stdout.write(String(index));
' "$openclaw_runtime/configured.json")"
run_openclaw config set "agents.list[$configured_index].model" \
  '"openrouter/openai/gpt-4.1"' --strict-json \
  > "$openclaw_runtime/config-updated.txt"
run_openclaw agents set-identity --agent orbitflow-proof \
  --identity-file "$openclaw_runtime/workspace/IDENTITY.md" --json \
  > "$openclaw_runtime/identity.json"
run_openclaw agents list --json > "$openclaw_runtime/updated.json"

node -e '
  const fs = require("node:fs");
  const created = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const listed = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const updated = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  if (created.agentId !== "orbitflow-proof") process.exit(1);
  if (!listed.some((agent) => agent.id === "main")) process.exit(1);
  const agent = updated.find((candidate) => candidate.id === "orbitflow-proof");
  if (!agent || agent.model !== "openrouter/openai/gpt-4.1") process.exit(1);
  if (agent.identityName !== "Runtime Proof") process.exit(1);
' "$openclaw_runtime/created.json" "$openclaw_runtime/listed.json" "$openclaw_runtime/updated.json"
echo "Exact-version offline agent create and edit path: passed"

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
  if [[ "$health" == "healthy" ]]; then
    break
  fi
  if [[ "$health" == "unhealthy" ]]; then
    echo "Disposable PostgreSQL container became unhealthy" >&2
    exit 1
  fi
  sleep 1
done

if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container_name")" != "healthy" ]]; then
  echo "Disposable PostgreSQL container did not become healthy" >&2
  exit 1
fi

host_port="$(docker port "$container_name" 5432/tcp | sed 's/.*://')"
export DATABASE_URL="postgresql://$database_user:$database_password@127.0.0.1:$host_port/$database_name"
export ORBITFACTORY_FACT11_PROOF_DATABASE="$database_name"

npm run test:runtime-adapter
