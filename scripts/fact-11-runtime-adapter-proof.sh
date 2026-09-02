#!/usr/bin/env bash
# FACT-11: exact OpenClaw version and the offline agent create/edit path, then
# the runtime adapter contract against disposable PostgreSQL.
set -euo pipefail

expected_openclaw_version="2026.4.15"
openclaw_runtime=""
cleanup() {
  case "$openclaw_runtime" in
    /tmp/orbitflow-fact11-openclaw-cli.*) [[ -d "$openclaw_runtime" ]] && find "$openclaw_runtime" -depth -delete ;;
  esac
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

scripts/with-postgres.sh -- env ORBITFACTORY_FACT11_PROOF_DATABASE=proof npm run test:runtime-adapter
