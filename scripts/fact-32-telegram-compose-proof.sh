#!/usr/bin/env bash
set -euo pipefail

redact_controlled_diagnostic() {
  local output="$1"

  printf '%s' "$output" | sed -E \
    -e 's/(TELEGRAM_BOT_TOKEN|OPENROUTER_API_KEY|POSTGRES_PASSWORD)=[^[:space:]]+/\1=[REDACTED]/g' \
    -e 's#(postgresql://[^:[:space:]]+:)[^@[:space:]]+@#\1[REDACTED]@#g' \
    -e 's/fact32-present-token/[REDACTED]/g' \
    -e 's/fact32-invalid-token/[REDACTED]/g' \
    -e 's/fact32-local-password/[REDACTED]/g' \
    -e 's/not-a-real-key-for-fact32-proof/[REDACTED]/g'
}

emit_negative_diagnostic() {
  local case_name="$1"
  local exit_status="$2"
  local output="$3"

  printf 'FACT-32 %s diagnostic: compose_run_exit=%s; captured stdout/stderr follows (last 40 lines, controlled credentials redacted)\n' "$case_name" "$exit_status" >&2
  redact_controlled_diagnostic "$output" | tail -n 40 >&2
}

if [[ "${FACT32_PROOF_TEST_LIB:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

project="orbitflow-fact32-proof-$$"
env_file="$(mktemp "${TMPDIR:-/tmp}/orbitflow-fact32-env.XXXXXX")"
missing_token_env_file="$(mktemp "${TMPDIR:-/tmp}/orbitflow-fact32-missing-token-env.XXXXXX")"
invalid_token_env_file="$(mktemp "${TMPDIR:-/tmp}/orbitflow-fact32-invalid-token-env.XXXXXX")"
started="false"

cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$started" == "true" ]]; then
    # The long-poll worker can observe PostgreSQL's shutdown while Compose
    # tears dependencies down. Force only this unique proof project afterward
    # and judge cleanup from the label-scoped postcondition below.
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -f "$env_file" "$missing_token_env_file" "$invalid_token_env_file" || status=1
  for kind in container network volume; do
    local ids
    if [[ "$kind" == "container" ]]; then
      ids="$(docker container ls -aq --filter "label=com.docker.compose.project=$project")"
    else
      ids="$(docker "$kind" ls -q --filter "label=com.docker.compose.project=$project")"
    fi
    if [[ -n "$ids" ]]; then
      case "$kind" in
        container) docker rm --force $ids >/dev/null || status=1 ;;
        network) docker network rm $ids >/dev/null || status=1 ;;
        volume) docker volume rm $ids >/dev/null || status=1 ;;
      esac
    fi
    if [[ "$kind" == "container" ]]; then
      ids="$(docker container ls -aq --filter "label=com.docker.compose.project=$project")"
    else
      ids="$(docker "$kind" ls -q --filter "label=com.docker.compose.project=$project")"
    fi
    if [[ -n "$ids" ]]; then
      echo "FACT-32 proof left $kind resources for $project: $ids" >&2
      status=1
    fi
  done
  local image_ids
  image_ids="$(docker image ls -aq --filter "label=com.docker.compose.project=$project" | sort -u)"
  if [[ -n "$image_ids" ]]; then
    docker image rm $image_ids >/dev/null || status=1
  fi
  exit "$status"
}
trap cleanup EXIT

write_env_file() {
  local destination="$1"
  local telegram_token="$2"

  cat >"$destination" <<EOF
POSTGRES_DB=orbitflow_fact32_proof
POSTGRES_USER=orbitflow
POSTGRES_PASSWORD=fact32-local-password
OPENROUTER_API_KEY=not-a-real-key-for-fact32-proof
TELEGRAM_BOT_TOKEN=$telegram_token
ORBITFACTORY_APP_PORT=$((41000 + ($$ % 1000)))
ORBITFACTORY_ENGINE_HOST_PORT=$((42000 + ($$ % 1000)))
ORBITFACTORY_DB_PATH=/app/data/orbitfactory.db
EOF
}

write_env_file "$env_file" "fact32-present-token"
write_env_file "$missing_token_env_file" ""
write_env_file "$invalid_token_env_file" "fact32-invalid-token"

compose_with_env() {
  local interpolation_file="$1"
  shift

  env -i PATH="$PATH" HOME="${HOME:?HOME is required}" \
    docker compose --project-name "$project" --env-file "$interpolation_file" \
      -f compose.yaml -f docker/fact32-telegram-proof.compose.yaml "$@"
}

compose() { compose_with_env "$env_file" "$@"; }

compose --profile telegram config --quiet
started="true"
compose --profile telegram build >/dev/null
compose --profile telegram up --detach --wait --wait-timeout 240 >/dev/null

telegram_id="$(compose ps --quiet telegram)"
[[ -n "$telegram_id" && "$(docker inspect --format '{{.State.Running}}' "$telegram_id")" == "true" ]]
sleep 2
[[ "$(docker inspect --format '{{.State.Running}}' "$telegram_id")" == "true" ]]
compose logs telegram-api-stub | grep -F "fake Telegram accepted getMe" >/dev/null

missing_exit=0
if missing_output="$(compose_with_env "$missing_token_env_file" run --rm --no-deps telegram 2>&1)"; then
  :
else
  missing_exit=$?
fi
if [[ "$missing_exit" -eq 0 ]]; then
  emit_negative_diagnostic "missing-token" "$missing_exit" "$missing_output"
  echo "Telegram missing-token process unexpectedly exited successfully" >&2
  exit 1
fi
if [[ "$missing_output" != *"TELEGRAM_BOT_TOKEN is required" ]]; then
  emit_negative_diagnostic "missing-token" "$missing_exit" "$missing_output"
  echo "Telegram missing-token failure did not reach the adapter guard" >&2
  exit 1
fi
if [[ "$missing_output" == *"fact32-present-token"* ]]; then
  emit_negative_diagnostic "missing-token" "$missing_exit" "$missing_output"
  echo "Compose wrapper exposed the controlled Telegram token" >&2
  exit 1
fi

invalid_token="fact32-invalid-token"
if invalid_output="$(compose_with_env "$invalid_token_env_file" run --rm --no-deps telegram 2>&1)"; then
  echo "Telegram invalid-token process unexpectedly exited successfully" >&2
  exit 1
fi
if [[ "$invalid_output" != *"Unauthorized" ]]; then
  echo "Telegram invalid-token failure did not reach the fake Telegram boundary" >&2
  exit 1
fi
if [[ "$invalid_output" == *"$invalid_token"* ]]; then
  echo "Telegram invalid-token failure exposed the controlled token" >&2
  exit 1
fi

echo "FACT-32 Telegram Compose proof passed for $project"
