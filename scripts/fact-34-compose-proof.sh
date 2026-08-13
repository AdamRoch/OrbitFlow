#!/usr/bin/env bash
set -euo pipefail

project="orbitfactory-fact34-proof-$$"
app_port="$((43000 + ($$ % 1000)))"
engine_port="$((44000 + ($$ % 1000)))"
env_file="$(mktemp "${TMPDIR:-/tmp}/orbitfactory-fact34-env.XXXXXX")"
started=false

cleanup() {
  proof_status=$?
  local image_ids
  trap - EXIT
  if [[ "$started" == true ]]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || proof_status=1
  fi
  rm -f "$env_file"
  for resource_type in container network volume; do
    if [[ -n "$(docker "$resource_type" ls -q --filter "label=com.docker.compose.project=$project")" ]]; then
      printf 'FACT-34 Compose proof left a %s for %s\n' "$resource_type" "$project" >&2
      proof_status=1
    fi
  done
  image_ids="$(docker image ls -aq --filter "label=com.docker.compose.project=$project" | sort -u)"
  if [[ -n "$image_ids" ]]; then
    docker image rm $image_ids >/dev/null 2>&1 || proof_status=1
  fi
  if [[ -n "$(docker image ls -q --filter "label=com.docker.compose.project=$project")" ]]; then
    printf 'FACT-34 Compose proof left an image for %s\n' "$project" >&2
    proof_status=1
  fi
  exit "$proof_status"
}
trap cleanup EXIT

printf '%s\n' \
  'POSTGRES_DB=orbitfactory_fact34_compose' \
  'POSTGRES_USER=orbitfactory' \
  'POSTGRES_PASSWORD=local' \
  'OPENROUTER_API_KEY=not-a-real-key-no-provider-call' \
  "ORBITFACTORY_APP_PORT=$app_port" \
  "ORBITFACTORY_ENGINE_HOST_PORT=$engine_port" \
  'ORBITFACTORY_DB_PATH=/app/data/orbitfactory.db' >"$env_file"

compose() {
  env -i PATH="$PATH" HOME="${HOME:?HOME is required}" \
    docker compose --project-name "$project" --env-file "$env_file" \
      -f compose.yaml -f docker/fact34-compose-proof.compose.yaml "$@"
}

wait_for_snapshot() {
  local predicate="$1"
  local snapshot=""
  for _ in {1..240}; do
    snapshot="$(compose exec -T engine node --experimental-strip-types scripts/fact-34-compose-fixture.mjs snapshot)"
    if node -e "const value=JSON.parse(process.argv[1]); if (!($predicate)) process.exit(1)" "$snapshot"; then
      printf '%s' "$snapshot"
      return 0
    fi
    sleep 0.25
  done
  printf 'Timed out waiting for FACT-34 state: %s\n' "$snapshot" >&2
  return 1
}

started=true
compose up --detach --build --wait --wait-timeout 300

readiness="$(node -e "fetch('http://127.0.0.1:$engine_port/readyz').then(async r=>{const b=await r.json();if(!r.ok)process.exit(1);process.stdout.write(JSON.stringify(b))})")"
node -e 'const value=JSON.parse(process.argv[1]); if(value.status!=="ready"||value.workflowEngine!=="operational")process.exit(1)' "$readiness"

compose exec -T engine node --experimental-strip-types scripts/fact-34-compose-fixture.mjs seed >/dev/null
pending="$(wait_for_snapshot 'value.run_status === "running" && value.questions === 1 && value.pending_questions === 1 && value.question_messages === 1 && value.outbound_messages === 1 && value.invocations === 1')"
node -e 'const value=JSON.parse(process.argv[1]);if(value.dispatches!==1||value.completed_dispatches!==1)process.exit(1)' "$pending"

delivered="$(compose exec -T engine node --experimental-strip-types scripts/fact-34-compose-fixture.mjs deliver)"
node -e 'const value=JSON.parse(process.argv[1]);if(value.delivered!==true||value.sent.chatId!=="-1003499"||value.sent.telegramMessageId!==34991)process.exit(1)' "$delivered"

compose restart engine >/dev/null
compose up --detach --wait --wait-timeout 120 engine >/dev/null
after_restart="$(wait_for_snapshot 'value.run_status === "running" && value.pending_questions === 1 && value.invocations === 1')"
node -e 'const before=JSON.parse(process.argv[1]);const after=JSON.parse(process.argv[2]);if(JSON.stringify(before)!==JSON.stringify(after))process.exit(1)' "$pending" "$after_restart"

answer="$(compose exec -T engine node --experimental-strip-types scripts/fact-34-compose-fixture.mjs answer)"
node -e 'const value=JSON.parse(process.argv[1]);if(value.kind!=="accepted")process.exit(1)' "$answer"
completed="$(wait_for_snapshot 'value.run_status === "completed" && value.answered_questions === 1 && value.answer_messages === 1 && value.dispatches === 2 && value.completed_dispatches === 2 && value.invocations === 2 && value.pending_messages === 0')"

compose restart engine >/dev/null
compose up --detach --wait --wait-timeout 120 engine >/dev/null
final="$(wait_for_snapshot 'value.run_status === "completed" && value.answered_questions === 1 && value.invocations === 2 && value.pending_messages === 0')"
node -e 'const before=JSON.parse(process.argv[1]);const after=JSON.parse(process.argv[2]);if(JSON.stringify(before)!==JSON.stringify(after))process.exit(1)' "$completed" "$final"

printf 'FACT-34 production adapter Compose proof passed for %s\n' "$project"
