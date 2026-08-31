#!/usr/bin/env bash
set -Eeuo pipefail

trap 'printf "FACT-49 production broker proof failed at line %s\n" "$LINENO" >&2' ERR

project="orbitfactory-fact49-proof-$$"
app_port="$((45000 + ($$ % 1000)))"
engine_port="$((46000 + ($$ % 1000)))"
env_file="$(mktemp "${TMPDIR:-/tmp}/orbitfactory-fact49-env.XXXXXX")"
started=false

cleanup() {
  proof_status=$?
  local resource_ids remaining image_ids labeled_image_ids named_image_ids
  trap - EXIT
  set +e
  if [[ "$started" == true ]]; then
    if ! compose down --volumes --remove-orphans --timeout 30; then
      printf 'FACT-49 proof Compose teardown failed for %s\n' "$project" >&2
      proof_status=1
    fi
  fi
  if ! rm -f "$env_file"; then
    printf 'FACT-49 proof could not remove its environment file\n' >&2
    proof_status=1
  fi
  for resource_type in container network volume; do
    if ! resource_ids="$(docker "$resource_type" ls -q --filter "label=com.docker.compose.project=$project")"; then
      printf 'FACT-49 proof could not inspect %s resources for %s\n' "$resource_type" "$project" >&2
      proof_status=1
      continue
    fi
    if [[ -n "$resource_ids" ]]; then
      printf 'FACT-49 proof found leftover %s resources for %s\n' "$resource_type" "$project" >&2
      proof_status=1
      case "$resource_type" in
        container) docker container rm --force $resource_ids >/dev/null 2>&1 || proof_status=1 ;;
        network) docker network rm $resource_ids >/dev/null 2>&1 || proof_status=1 ;;
        volume) docker volume rm $resource_ids >/dev/null 2>&1 || proof_status=1 ;;
      esac
    fi
    if ! remaining="$(docker "$resource_type" ls -q --filter "label=com.docker.compose.project=$project")"; then
      printf 'FACT-49 proof could not verify %s cleanup for %s\n' "$resource_type" "$project" >&2
      proof_status=1
    elif [[ -n "$remaining" ]]; then
      printf 'FACT-49 proof left a %s for %s\n' "$resource_type" "$project" >&2
      proof_status=1
    fi
  done
  if ! labeled_image_ids="$(docker image ls -aq --filter "label=com.docker.compose.project=$project")"; then
    printf 'FACT-49 proof could not inspect labelled images for %s\n' "$project" >&2
    proof_status=1
    labeled_image_ids=""
  fi
  if ! named_image_ids="$(docker image ls -aq --filter "reference=$project-*")"; then
    printf 'FACT-49 proof could not inspect named images for %s\n' "$project" >&2
    proof_status=1
    named_image_ids=""
  fi
  image_ids="$(printf '%s\n' "$labeled_image_ids" "$named_image_ids" | sed '/^$/d' | sort -u)"
  if [[ -n "$image_ids" ]]; then
    docker image rm $image_ids >/dev/null 2>&1 || proof_status=1
  fi
  if ! labeled_image_ids="$(docker image ls -q --filter "label=com.docker.compose.project=$project")"; then
    printf 'FACT-49 proof could not verify labelled-image cleanup for %s\n' "$project" >&2
    proof_status=1
  fi
  if ! named_image_ids="$(docker image ls -q --filter "reference=$project-*")"; then
    printf 'FACT-49 proof could not verify named-image cleanup for %s\n' "$project" >&2
    proof_status=1
  fi
  if [[ -n "$labeled_image_ids" || -n "$named_image_ids" ]]; then
    printf 'FACT-49 proof left an image for %s\n' "$project" >&2
    proof_status=1
  fi
  exit "$proof_status"
}
trap cleanup EXIT

for resource_type in container network volume; do
  if [[ -n "$(docker "$resource_type" ls -q --filter "label=com.docker.compose.project=$project")" ]]; then
    printf 'Refusing to touch existing FACT-49 %s for %s\n' "$resource_type" "$project" >&2
    exit 1
  fi
done
if [[ -n "$(docker image ls -aq --filter "label=com.docker.compose.project=$project")" || -n "$(docker image ls -aq --filter "reference=$project-*")" ]]; then
  printf 'Refusing to touch existing FACT-49 images for %s\n' "$project" >&2
  exit 1
fi

printf '%s\n' \
  'POSTGRES_DB=orbitfactory_fact49_compose' \
  'POSTGRES_USER=orbitfactory' \
  'POSTGRES_PASSWORD=local' \
  'OPENROUTER_API_KEY=not-a-real-key-no-provider-call' \
  "ORBITFACTORY_APP_PORT=$app_port" \
  "ORBITFACTORY_ENGINE_HOST_PORT=$engine_port" >"$env_file"

compose() {
  env -i PATH="$PATH" HOME="${HOME:?HOME is required}" COMPOSE_PROGRESS=plain \
    docker compose --project-name "$project" --env-file "$env_file" \
      -f compose.yaml \
      -f docker/fact34-compose-proof.compose.yaml \
      -f docker/fact49-compose-proof.compose.yaml "$@"
}

wait_for_snapshot() {
  local run_id="$1"
  local predicate="$2"
  local snapshot=""
  for _ in {1..240}; do
    snapshot="$(compose exec -T engine node --experimental-strip-types scripts/fact-49-compose-fixture.mjs snapshot "$run_id")"
    if node -e "const value=JSON.parse(process.argv[1]); if (!($predicate)) process.exit(1)" "$snapshot"; then
      printf '%s' "$snapshot"
      return 0
    fi
    sleep 0.25
  done
  printf 'Timed out waiting for FACT-49 state: %s\n' "$snapshot" >&2
  return 1
}

agent_proof() {
  local agent_ref="$1"
  local session_id="$2"
  local prompt="$3"
  compose exec -T --user node openclaw sh -c '
    export OPENCLAW_GATEWAY_TOKEN="$(cat /home/node/.openclaw/gateway-token)"
    exec node /opt/openclaw/openclaw.mjs agent --agent "$1" --session-id "$2" --message "$3" --timeout 30 --json
  ' -- "$agent_ref" "$session_id" "$prompt"
}

started=true
compose up --detach --build --wait --wait-timeout 300

readiness="$(node -e "fetch('http://127.0.0.1:$engine_port/readyz').then(async r=>{const b=await r.json();if(!r.ok)process.exit(1);process.stdout.write(JSON.stringify(b))})")"
node -e 'const value=JSON.parse(process.argv[1]);if(value.status!=="ready"||value.workflowEngine!=="operational")process.exit(1)' "$readiness"

identity="$(compose exec -T engine node --experimental-strip-types scripts/fact-49-compose-fixture.mjs identity)"
node -e 'const value=JSON.parse(process.argv[1]);if(value.database!=="orbitfactory_fact49_compose")process.exit(1)' "$identity"

seeded="$(compose exec -T engine node --experimental-strip-types scripts/fact-49-compose-fixture.mjs seed)"
run_id="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).runId))' "$seeded")"
planner_id="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).plannerId))' "$seeded")"
implementer_id="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).implementerId))' "$seeded")"
target_id="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).targetTicketId))' "$seeded")"
blocker_id="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).blockerTicketId))' "$seeded")"
escape_id="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).escapeTicketId))' "$seeded")"

compose exec -T openclaw node -e '
  const fs=require("node:fs");
  const config=JSON.parse(fs.readFileSync("/home/node/.openclaw/openclaw.json","utf8"));
  const approvals=JSON.parse(fs.readFileSync("/home/node/.openclaw/exec-approvals.json","utf8"));
  const entry=approvals.agents["*"].allowlist.find((candidate)=>candidate.pattern==="/app/bin/orbit-openclaw-tool.mjs");
  if(!entry||!new RegExp(entry.argPattern).test("set_ticket_dependencies {}"))process.exit(1);
  if(config.tools.exec.security!=="allowlist"||config.tools.exec.ask!=="off")process.exit(1);
  if(Object.hasOwn(process.env,"DATABASE_URL"))process.exit(1);
'

planner_dispatch="$(wait_for_snapshot "$run_id" 'value.runStatus === "running" && value.dispatches === 1 && value.dispatchingDispatches === 1 && value.openclawInputs === 1 && value.dispatchRows[0].ticketId === null')"
node -e 'const value=JSON.parse(process.argv[1]);const ticket=value.tickets.find((row)=>row.id===process.argv[2]);if(!ticket||ticket.status!=="todo"||ticket.blockerTicketIds.length!==0)process.exit(1)' "$planner_dispatch" "$target_id"

planner_workspace="/var/lib/orbitflow/runtime/workspaces/orbitflow-$planner_id"
compose exec -T --user node openclaw node /opt/openclaw/openclaw.mjs agents add \
  "orbitflow-$planner_id" --workspace "$planner_workspace" \
  --model openrouter/openai/gpt-4.1-mini --non-interactive --json >/dev/null
if ! planner_result="$(agent_proof "orbitflow-$planner_id" fact49-planner FACT49_PLANNER 2>&1)"; then
  printf 'Planner wrapper/broker invocation failed: %s\n' "$planner_result" >&2
  exit 1
fi
node -e '
  const value=JSON.parse(process.argv[1]);
  const text=value.result?.payloads?.[0]?.text??"";
  if(!text.startsWith("PROOF_RESULT ")||!text.includes("\"ok\":true")||!text.includes("BKR-2")){console.error(process.argv[1]);process.exit(1)}
' "$planner_result"

planner_proof="$(compose exec -T engine node --experimental-strip-types scripts/fact-49-compose-fixture.mjs planner-proof "$run_id" "$target_id" "$escape_id" "$blocker_id" "$planner_id")"
node -e '
  const value=JSON.parse(process.argv[1]);
  if(value.invocationCount!==1||value.invocationAgentId!==process.argv[5]||value.invocationRunId!==process.argv[6]||value.responseTicket?.id!==process.argv[2]||JSON.stringify(value.responseTicket?.blockerTicketIds)!==JSON.stringify([process.argv[3]]))process.exit(1);
  if(value.target.id!==process.argv[2]||value.target.status!=="todo"||JSON.stringify(value.target.blockerTicketIds)!==JSON.stringify([process.argv[3]]))process.exit(1);
  if(value.escape.id!==process.argv[4]||value.escape.status!=="backlog"||value.escape.blockerTicketIds.length!==0)process.exit(1);
' "$planner_proof" "$target_id" "$blocker_id" "$escape_id" "$planner_id" "$run_id"

compose exec -T --user node engine node --experimental-strip-types scripts/fact-49-compose-fixture.mjs release planner >/dev/null
bound_dispatch="$(wait_for_snapshot "$run_id" 'value.runStatus === "running" && value.dispatches === 2 && value.dispatchingDispatches === 1 && value.openclawInputs === 2')"
node -e 'const value=JSON.parse(process.argv[1]);if(value.dispatchRows[1]?.ticketId!==process.argv[2])process.exit(1)' "$bound_dispatch" "$target_id"

compose exec -T engine node --experimental-strip-types scripts/fact-49-compose-fixture.mjs make-escape-todo "$escape_id" >/dev/null

bound_workspace="/var/lib/orbitflow/runtime/workspaces/orbitflow-$implementer_id"
for bound_agent_ref in "orbitflow-$implementer_id" "orbitflow-$implementer_id-attribution"; do
  compose exec -T --user node openclaw node /opt/openclaw/openclaw.mjs agents add \
    "$bound_agent_ref" --workspace "$bound_workspace" \
    --model openrouter/openai/gpt-4.1-mini --non-interactive --json >/dev/null
done
if ! bound_result="$(agent_proof "orbitflow-$implementer_id" fact49-bound FACT49_BOUND 2>&1)"; then
  printf 'Bound wrapper/broker invocation failed: %s\n' "$bound_result" >&2
  exit 1
fi
node -e '
  const value=JSON.parse(process.argv[1]);
  const text=value.result?.payloads?.[0]?.text??"";
  if(!text.startsWith("PROOF_RESULT ")||!text.includes("\"ok\":false")||!text.includes("ticket_not_todo")){console.error(process.argv[1]);process.exit(1)}
' "$bound_result"

if ! bound_attribution="$(agent_proof "orbitflow-$implementer_id-attribution" fact49-bound-attribution FACT49_BOUND_ATTRIBUTION 2>&1)"; then
  printf 'Bound attribution wrapper invocation failed: %s\n' "$bound_attribution" >&2
  exit 1
fi
node -e '
  const value=JSON.parse(process.argv[1]);
  const text=value.result?.payloads?.[0]?.text??"";
  if(!text.startsWith("PROOF_RESULT ")||!text.includes("\"ok\":false")||!text.includes("runId is bound")){console.error(process.argv[1]);process.exit(1)}
' "$bound_attribution"

bound_proof="$(compose exec -T engine node --experimental-strip-types scripts/fact-49-compose-fixture.mjs bound-proof "$run_id" "$target_id" "$escape_id")"
node -e '
  const value=JSON.parse(process.argv[1]);
  if(value.boundInvocationCount!==0||value.attributionInvocationCount!==0)process.exit(1);
  if(value.target.id!==process.argv[2]||value.target.status!=="in_progress"||JSON.stringify(value.target.blockerTicketIds)!==JSON.stringify([process.argv[4]]))process.exit(1);
  if(value.escape.id!==process.argv[3]||value.escape.status!=="todo"||value.escape.blockerTicketIds.length!==0)process.exit(1);
' "$bound_proof" "$target_id" "$escape_id" "$blocker_id"

compose exec -T --user node engine node --experimental-strip-types scripts/fact-49-compose-fixture.mjs release bound >/dev/null
final="$(wait_for_snapshot "$run_id" 'value.runStatus === "completed" && value.dispatches === 2 && value.completedDispatches === 2 && value.dispatchingDispatches === 0')"
node -e 'const value=JSON.parse(process.argv[1]);if(value.tickets.some((ticket)=>ticket.status!=="in_progress"&&ticket.id===process.argv[2]))process.exit(1)' "$final" "$target_id"

printf 'FACT-49 production broker proof passed for %s\n' "$project"
