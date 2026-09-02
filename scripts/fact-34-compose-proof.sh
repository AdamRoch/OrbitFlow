#!/usr/bin/env bash
set -Eeuo pipefail

trap 'printf "FACT-34 Compose proof failed at line %s\n" "$LINENO" >&2' ERR

project="orbitfactory-fact34-proof-$$"
app_port="$((43000 + ($$ % 1000)))"
engine_port="$((44000 + ($$ % 1000)))"
env_file="$(mktemp "${TMPDIR:-/tmp}/orbitfactory-fact34-env.XXXXXX")"
started=false
cancel_log=""

cleanup() {
  proof_status=$?
  local image_ids
  trap - EXIT
  if [[ "$started" == true ]]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || proof_status=1
  fi
  rm -f "$env_file"
  if [[ -n "$cancel_log" ]]; then rm -f "$cancel_log"; fi
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
  "ORBITFACTORY_ENGINE_HOST_PORT=$engine_port" >"$env_file"

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

wait_for_aux() {
  local run_id="$1"
  local predicate="$2"
  local snapshot=""
  for _ in {1..240}; do
    snapshot="$(compose exec -T engine node --experimental-strip-types scripts/fact-34-compose-fixture.mjs aux-snapshot "$run_id")"
    if node -e "const value=JSON.parse(process.argv[1]); if (!($predicate)) process.exit(1)" "$snapshot"; then
      printf '%s' "$snapshot"
      return 0
    fi
    sleep 0.25
  done
  printf 'Timed out waiting for FACT-34 auxiliary run %s: %s\n' "$run_id" "$snapshot" >&2
  return 1
}

start_aux_workspace() {
  local run_id="$1"
  local agent_id="$2"
  local agent_workspace="/var/lib/orbitflow/runtime/workspaces/orbitflow-$agent_id"
  for _ in {1..120}; do
    if compose exec -T --user node --workdir "$agent_workspace" openclaw \
      /app/bin/orbit-openclaw-tool.mjs start_run_workspace '{}' >/dev/null 2>&1; then
      printf '%s' "$agent_workspace"
      return 0
    fi
    sleep 0.25
  done
  printf 'Timed out starting auxiliary workspace for run %s\n' "$run_id" >&2
  return 1
}

started=true
compose up --detach --build --wait --wait-timeout 300

readiness="$(node -e "fetch('http://127.0.0.1:$engine_port/readyz').then(async r=>{const b=await r.json();if(!r.ok)process.exit(1);process.stdout.write(JSON.stringify(b))})")"
node -e 'const value=JSON.parse(process.argv[1]); if(value.status!=="ready"||value.workflowEngine!=="operational")process.exit(1)' "$readiness"

seeded="$(compose exec -T engine node --experimental-strip-types scripts/fact-34-compose-fixture.mjs seed)"
run_id="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).runId))' "$seeded")"
agent_id="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).agentId))' "$seeded")"
project_id="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).projectId))' "$seeded")"
other_agent_id="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).otherAgentId))' "$seeded")"
other_run_id="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).otherRunId))' "$seeded")"

compose exec -T openclaw node -e '
  const fs=require("node:fs");
  const config=JSON.parse(fs.readFileSync("/home/node/.openclaw/openclaw.json","utf8"));
  const approvals=JSON.parse(fs.readFileSync("/home/node/.openclaw/exec-approvals.json","utf8"));
  const patterns=approvals.agents["*"].allowlist.map(entry=>entry.pattern).sort();
  if(Object.hasOwn(process.env,"DATABASE_URL")||fs.existsSync("/run/orbitflow/tool-env.json"))process.exit(1);
  if(config.tools.exec.security!=="allowlist"||config.tools.exec.ask!=="off")process.exit(1);
  if(JSON.stringify(patterns)!==JSON.stringify(["/app/bin/orbit-openclaw-tool.mjs"]))process.exit(1);
'
live_dispatch="$(wait_for_snapshot 'value.run_status === "running" && value.dispatches === 1 && value.dispatching_dispatches === 1 && value.openclaw_inputs === 1')"
node -e 'const value=JSON.parse(process.argv[1]);if(value.questions!==0||value.invocations!==0)process.exit(1)' "$live_dispatch"

agent_workspace="/var/lib/orbitflow/runtime/workspaces/orbitflow-$agent_id"
if ! workspace_started="$(compose exec -T --user node --workdir "$agent_workspace" openclaw \
  /app/bin/orbit-openclaw-tool.mjs start_run_workspace '{}' 2>&1)"; then
  printf 'Engine-context workspace start failed: %s\n' "$workspace_started" >&2
  exit 1
fi
node -e '
  const value=JSON.parse(process.argv[1]);
  if(value.ok!==true||value.result.workspace!==process.argv[2])process.exit(1);
' "$workspace_started" "/var/lib/orbitflow/run-workspaces/run-$run_id"
compose exec -T coding-executor node -e '
  const fs=require("node:fs");
  const path=require("node:path");
  const root="/var/lib/orbitflow/run-workspaces";
  const workspace=path.join(root,`run-${process.argv[1]}`);
  const stat=fs.lstatSync(workspace);
  const identity=JSON.parse(fs.readFileSync(path.join(root,".orbitflow","executor-identities",`uid-${stat.uid}.json`),"utf8"));
  const keys=["gid","runId","state","uid","version","workspace","workspaceDevice","workspaceInode"];
  if(JSON.stringify(Object.keys(identity).sort())!==JSON.stringify(keys))process.exit(1);
  if(identity.version!==2||identity.state!=="active"||identity.runId!==process.argv[1]||identity.workspace!==workspace||identity.uid!==stat.uid||identity.gid!==stat.gid||identity.workspaceDevice!==String(stat.dev)||identity.workspaceInode!==String(stat.ino))process.exit(1);
  const target=path.join(root,`run-${process.argv[2]}`);
  fs.mkdirSync(target,{mode:0o700});
  const otherUid=identity.uid===59999?20000:identity.uid+1;
  fs.chownSync(target,otherUid,otherUid);
' "$run_id" "$other_run_id"
if ! delegated="$(compose exec -T --user node --workdir "$agent_workspace" openclaw \
  /app/bin/orbit-openclaw-tool.mjs delegate_coding_task \
  "{\"task\":\"FACT34_ISOLATION other-run=$other_run_id\"}" 2>&1)"; then
  printf 'Engine-context coding delegation failed: %s\n' "$delegated" >&2
  exit 1
fi
node -e '
  const value=JSON.parse(process.argv[1]);
  if(value.ok!==true||value.result.usage.inputTokens!==11||value.result.usage.outputTokens!==7||value.result.usage.costUsd!==0.01)process.exit(1);
' "$delegated"
compose exec -T coding-executor node -e '
  const fs=require("node:fs");
  const path=require("node:path");
  const workspace=path.join("/var/lib/orbitflow/run-workspaces",`run-${process.argv[1]}`);
  if(fs.readFileSync(path.join(workspace,"delegated.txt"),"utf8")!=="engine-produced delegation succeeded\n")process.exit(1);
  const proof=JSON.parse(fs.readFileSync(path.join(workspace,"isolation-proof.json"),"utf8"));
  for(const field of ["databaseEnvironmentPresent","databaseCredentialReadable","brokerSocketReadable","executorSocketReadable","brokerExecutable","workspaceRootListable","otherWorkspaceReadable","directPostgresConnected"]){
    if(proof[field]!==false)process.exit(1);
  }
  if(!Number.isInteger(proof.uid)||proof.uid<20000||proof.gid!==proof.uid)process.exit(1);
' "$run_id"
for proof_agent in "orbitflow-$agent_id" "orbitflow-$agent_id-deny-unlisted" "orbitflow-$agent_id-deny-assignment"; do
  if ! agent_setup="$(compose exec -T --user node openclaw node /opt/openclaw/openclaw.mjs agents add \
    "$proof_agent" --workspace "$agent_workspace" \
    --model openrouter/openai/gpt-4.1-mini --non-interactive --json 2>&1)"; then
    printf 'Agent-side proof setup failed: %s\n' "$agent_setup" >&2
    exit 1
  fi
done
agent_proof() {
  local agent_ref="$1"
  local session_id="$2"
  local prompt="$3"
  compose exec -T --user node openclaw sh -c '
    export OPENCLAW_GATEWAY_TOKEN="$(cat /home/node/.openclaw/gateway-token)"
    exec node /opt/openclaw/openclaw.mjs agent --agent "$1" --session-id "$2" --message "$3" --timeout 30 --json
  ' -- "$agent_ref" "$session_id" "$prompt"
}

if ! allowed="$(agent_proof "orbitflow-$agent_id" fact34-allowed FACT34_ALLOW_PROJECTS 2>&1)"; then
  printf 'Allowlisted agent-side proof failed: %s\n' "$allowed" >&2
  exit 1
fi
if ! node -e 'if(!process.argv[1].includes("PROOF_RESULT")||!process.argv[1].includes("\\\"ok\\\":true")||!process.argv[1].includes("CMP"))process.exit(1)' "$allowed"; then
  printf 'Allowlisted agent-side proof returned unexpected output: %s\n' "$allowed" >&2
  exit 1
fi

if ! denied_unlisted="$(agent_proof "orbitflow-$agent_id-deny-unlisted" fact34-deny-unlisted FACT34_DENY_UNLISTED 2>&1)"; then
  printf 'Unlisted-command denial proof failed: %s\n' "$denied_unlisted" >&2
  exit 1
fi
if ! node -e 'if(!/denied|not allowlisted|approval|not permitted/i.test(process.argv[1]))process.exit(1)' "$denied_unlisted"; then
  printf 'Unlisted-command proof returned unexpected output: %s\n' "$denied_unlisted" >&2
  exit 1
fi

if ! denied_assignment="$(agent_proof "orbitflow-$agent_id-deny-assignment" fact34-deny-assignment FACT34_DENY_ASSIGNMENT 2>&1)"; then
  printf 'Assignment-prefix denial proof failed: %s\n' "$denied_assignment" >&2
  exit 1
fi
if ! node -e 'if(!/denied|not allowlisted|approval|not permitted/i.test(process.argv[1]))process.exit(1)' "$denied_assignment"; then
  printf 'Assignment-prefix proof returned unexpected output: %s\n' "$denied_assignment" >&2
  exit 1
fi

if compose exec -T --user node --workdir "$agent_workspace" openclaw \
  /app/bin/orbit-openclaw-tool.mjs list_projects \
  "{\"runId\":\"$other_run_id\",\"limit\":10,\"idempotencyKey\":\"fact34-cross-run\"}" >/dev/null 2>&1; then
  printf 'Cross-run attribution substitution was accepted\n' >&2
  exit 1
fi
if compose exec -T --user node --workdir "$agent_workspace" openclaw \
  /app/bin/orbit-openclaw-tool.mjs list_projects \
  "{\"agentId\":\"$other_agent_id\",\"limit\":10,\"idempotencyKey\":\"fact34-cross-agent\"}" >/dev/null 2>&1; then
  printf 'Cross-agent attribution substitution was accepted\n' >&2
  exit 1
fi
compose exec -T --user node engine node --experimental-strip-types scripts/fact-34-compose-fixture.mjs \
  tamper-tool-context "$agent_id" "$other_run_id" >/dev/null
if compose exec -T --user node --workdir "$agent_workspace" openclaw \
  /app/bin/orbit-openclaw-tool.mjs list_projects \
  '{"limit":10,"idempotencyKey":"fact34-tampered-context"}' >/dev/null 2>&1; then
  printf 'Tampered immutable dispatch context was accepted\n' >&2
  exit 1
fi
tool_proof="$(compose exec -T engine node --experimental-strip-types scripts/fact-34-compose-fixture.mjs tool-proof)"
node -e '
  const value=JSON.parse(process.argv[1]);
  if(JSON.stringify(value.keys)!==JSON.stringify(["fact34-agent-side-allowed"]))process.exit(1);
  if(value.codingCosts.length!==1)process.exit(1);
  const cost=value.codingCosts[0];
  if(cost.runId!==process.argv[2]||cost.agentId!==process.argv[3]||cost.model!=="proof/isolation-model"||cost.tokensIn!=="11"||cost.tokensOut!=="7"||cost.cost!=="0.01000000")process.exit(1);
' "$tool_proof" "$run_id" "$agent_id"
compose exec -T --user node engine node --experimental-strip-types scripts/fact-34-compose-fixture.mjs release-tool-proof >/dev/null

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

tamper_seed="$(compose exec -T engine node --experimental-strip-types scripts/fact-34-compose-fixture.mjs seed-aux tamper)"
tamper_run_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).runId)' "$tamper_seed")"
tamper_agent_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).agentId)' "$tamper_seed")"
wait_for_aux "$tamper_run_id" 'value.runStatus === "running" && value.dispatchStatus === "dispatching" && value.leaseActive === true && value.wakeInputs === 1' >/dev/null
tamper_agent_workspace="$(start_aux_workspace "$tamper_run_id" "$tamper_agent_id")"
if tamper_result="$(compose exec -T --user node --workdir "$tamper_agent_workspace" openclaw \
  /app/bin/orbit-openclaw-tool.mjs delegate_coding_task '{"task":"FACT34_TAMPER_MARKER"}' 2>&1)"; then
  printf 'Durable workspace marker tampering was accepted\n' >&2
  exit 1
fi
node -e '
  const value=JSON.parse(process.argv[1]);
  if(value.ok!==false||value.error.code!=="workspace_invalid"||!/ownership changed/.test(value.error.message))process.exit(1);
' "$tamper_result"
tamper_proof="$(compose exec -T tool-broker node --experimental-strip-types scripts/fact-34-compose-fixture.mjs aux-workspace-proof "$tamper_run_id")"
node -e '
  const value=JSON.parse(process.argv[1]);
  if(value.costEvents!==0||value.record?.state!=="active"){
    console.error(`Unexpected tamper proof state: ${process.argv[1]}`);
    process.exit(1);
  }
' "$tamper_proof"
compose exec -T engine node --experimental-strip-types scripts/fact-34-compose-fixture.mjs release-aux tamper >/dev/null
wait_for_aux "$tamper_run_id" '["completed", "failed"].includes(value.runStatus) && ["completed", "failed"].includes(value.dispatchStatus)' >/dev/null

quarantine_seed="$(compose exec -T engine node --experimental-strip-types scripts/fact-34-compose-fixture.mjs seed-aux quarantine)"
quarantine_run_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).runId)' "$quarantine_seed")"
quarantine_agent_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).agentId)' "$quarantine_seed")"
wait_for_aux "$quarantine_run_id" 'value.runStatus === "running" && value.dispatchStatus === "dispatching" && value.leaseActive === true && value.wakeInputs === 1' >/dev/null
quarantine_agent_workspace="$(start_aux_workspace "$quarantine_run_id" "$quarantine_agent_id")"
if quarantine_result="$(compose exec -T --user node --workdir "$quarantine_agent_workspace" openclaw \
  /app/bin/orbit-openclaw-tool.mjs delegate_coding_task '{"task":"FACT34_CREDENTIAL_EXPOSURE"}' 2>&1)"; then
  printf 'Credential-contaminated workspace was accepted\n' >&2
  exit 1
fi
node -e '
  const value=JSON.parse(process.argv[1]);
  if(value.ok!==false||value.error.code!=="credential_exposure")process.exit(1);
' "$quarantine_result"
quarantine_proof="$(compose exec -T tool-broker node --experimental-strip-types scripts/fact-34-compose-fixture.mjs aux-workspace-proof "$quarantine_run_id")"
node -e '
  const value=JSON.parse(process.argv[1]);
  if(value.costEvents!==0||value.record?.state!=="quarantined"||!value.record.quarantinePath.endsWith(`run-${process.argv[2]}-${value.record.workspaceId}`))process.exit(1);
' "$quarantine_proof" "$quarantine_run_id"
compose exec -T coding-executor sh -c \
  'test ! -e "/var/lib/orbitflow/run-workspaces/run-$1" && test -d "/var/lib/orbitflow/run-workspaces/.orbitflow/quarantine/run-$1-$2"' \
  -- "$quarantine_run_id" "$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).record.workspaceId)' "$quarantine_proof")"
compose exec -T engine node --experimental-strip-types scripts/fact-34-compose-fixture.mjs release-aux quarantine >/dev/null
wait_for_aux "$quarantine_run_id" '["completed", "failed"].includes(value.runStatus) && ["completed", "failed"].includes(value.dispatchStatus)' >/dev/null

cancel_seed="$(compose exec -T engine node --experimental-strip-types scripts/fact-34-compose-fixture.mjs seed-aux cancel)"
cancel_run_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).runId)' "$cancel_seed")"
cancel_agent_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).agentId)' "$cancel_seed")"
wait_for_aux "$cancel_run_id" 'value.runStatus === "running" && value.dispatchStatus === "dispatching" && value.leaseActive === true && value.wakeInputs === 1' >/dev/null
cancel_agent_workspace="$(start_aux_workspace "$cancel_run_id" "$cancel_agent_id")"
cancel_log="$(mktemp "${TMPDIR:-/tmp}/orbitfactory-fact34-cancel.XXXXXX")"
(
  trap - ERR
  compose exec -T --user node --workdir "$cancel_agent_workspace" openclaw \
    /app/bin/orbit-openclaw-tool.mjs delegate_coding_task '{"task":"FACT34_CANCEL"}'
) >"$cancel_log" 2>&1 &
cancel_client_pid=$!
for _ in {1..120}; do
  if compose exec -T coding-executor test -f "/var/lib/orbitflow/run-workspaces/run-$cancel_run_id/cancellation-process.json"; then
    break
  fi
  sleep 0.25
done
cancel_process="$(compose exec -T coding-executor node -e '
  const fs=require("node:fs");
  const value=JSON.parse(fs.readFileSync(`/var/lib/orbitflow/run-workspaces/run-${process.argv[1]}/cancellation-process.json`,"utf8"));
  process.stdout.write(String(value.pid));
' "$cancel_run_id")"
compose stop engine >/dev/null
compose exec -T tool-broker node --experimental-strip-types scripts/fact-34-compose-fixture.mjs expire-aux-lease "$cancel_run_id" >/dev/null
if wait "$cancel_client_pid"; then
  printf 'Lease-expired coding delegation returned success\n' >&2
  exit 1
fi
cancel_result="$(cat "$cancel_log")"
rm -f "$cancel_log"
cancel_log=""
node -e '
  const value=JSON.parse(process.argv[1]);
  if(value.ok!==false||value.error.code!=="cli_failure"||!/lease expired/.test(value.error.message))process.exit(1);
' "$cancel_result"
compose exec -T coding-executor node -e '
  try { process.kill(Number(process.argv[1]),0); process.exit(1); }
  catch (error) { if(error.code!=="ESRCH") throw error; }
' "$cancel_process"
cancel_proof="$(compose exec -T tool-broker node --experimental-strip-types scripts/fact-34-compose-fixture.mjs aux-workspace-proof "$cancel_run_id")"
node -e 'const value=JSON.parse(process.argv[1]);if(value.costEvents!==0||value.record?.state!=="active")process.exit(1)' "$cancel_proof"

printf 'FACT-34 production adapter Compose proof passed for %s\n' "$project"
