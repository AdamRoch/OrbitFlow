import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertProofDatabase } from "./proof-database.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

const fakeDockerScript = `#!/usr/bin/env bash
set -u

log_file="\${FAKE_DOCKER_LOG:-$(cd "$(dirname "$0")/.." && pwd)/docker.log}"
printf '%s\\n' "$*" >> "$log_file"
command="\${1:-}"
subcommand="\${2:-}"
compose_config="$(cd "$(dirname "$0")/.." && pwd)/compose-config"
compose_app_endpoint="127.0.0.1:51001"
compose_engine_endpoint="127.0.0.1:51002"
compose_down_exit="0"
if [[ -f "$compose_config" ]]; then
  exec 3< "$compose_config"
  IFS= read -r compose_app_endpoint <&3
  IFS= read -r compose_engine_endpoint <&3
  IFS= read -r compose_down_exit <&3
  exec 3<&-
fi

if [[ "$command" == "compose" ]]; then
  compose_command=""
  for argument in "$@"; do
    case "$argument" in
      up|down|exec|port|restart)
        compose_command="$argument"
        break
        ;;
    esac
  done
  if [[ "$compose_command" == "port" ]]; then
    service=""
    container_port=""
    for argument in "$@"; do
      case "$argument" in
        app|engine) service="$argument" ;;
        3000|3001) container_port="$argument" ;;
      esac
    done
    case "$service:$container_port" in
      app:3000) printf '%s\\n' "$compose_app_endpoint" ;;
      engine:3001) printf '%s\\n' "$compose_engine_endpoint" ;;
      *) printf 'unexpected fake compose port command: %s\\n' "$*" >&2; exit 1 ;;
    esac
    exit 0
  fi
  if [[ "$compose_command" == "down" ]]; then
    exit "$compose_down_exit"
  fi
  case "$compose_command" in
    up|exec|restart) exit 0 ;;
    *) printf 'unexpected fake compose command: %s\\n' "$*" >&2; exit 1 ;;
  esac
fi

if [[ "$command" == "container" && "$subcommand" == "inspect" ]]; then
  [[ -f "$FAKE_DOCKER_STATE" ]]
  exit $?
fi
if [[ "$subcommand" == "ls" ]] && [[ "$command" == "container" || "$command" == "network" || "$command" == "volume" || "$command" == "image" ]]; then
  exit 0
fi
if [[ "$command" == "inspect" ]]; then
  [[ -f "$FAKE_DOCKER_STATE" ]] && printf 'healthy\\n'
  exit $?
fi
if [[ "$command" == "run" ]]; then
  touch "$FAKE_DOCKER_STATE"
  exit 0
fi
if [[ "$command" == "port" ]]; then
  printf '127.0.0.1:54321\\n'
  exit 0
fi
if [[ "$command" == "exec" ]]; then
  exit 0
fi
if [[ "$command" == "rm" ]]; then
  if [[ "\${FAKE_DOCKER_RM_EXIT:-0}" != "0" ]]; then
    [[ "\${FAKE_DOCKER_PRESERVE_AFTER_RM:-0}" == "1" ]] || rm -f "$FAKE_DOCKER_STATE"
    exit 1
  fi
  rm -f "$FAKE_DOCKER_STATE"
  printf '%s\\n' "\${3:-proof-container}"
  exit 0
fi

printf 'unexpected fake docker command: %s\\n' "$*" >&2
exit 1
`;

const fakeNodeScript = `#!/usr/bin/env bash
exit "\${FAKE_NODE_EXIT:-0}"
`;

function runCommand(command, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function runProofScript(script, {
  nodeExit,
  rmExit,
  preserveAfterRm,
  preexisting = false,
  appEndpoint = "127.0.0.1:51001",
  engineEndpoint = "127.0.0.1:51002",
  composeDownExit = 0,
}) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "orbitflow-fact45-shell-"));
  const binDirectory = path.join(temporaryRoot, "bin");
  const stateFile = path.join(temporaryRoot, "container-state");
  const logFile = path.join(temporaryRoot, "docker.log");
  const composeConfigFile = path.join(temporaryRoot, "compose-config");
  await mkdir(binDirectory);
  const dockerPath = path.join(binDirectory, "docker");
  const nodePath = path.join(binDirectory, "node");
  await writeFile(dockerPath, fakeDockerScript);
  await writeFile(nodePath, fakeNodeScript);
  await Promise.all([chmod(dockerPath, 0o755), chmod(nodePath, 0o755)]);
  await Promise.all([
    writeFile(logFile, ""),
    writeFile(composeConfigFile, `${appEndpoint}\n${engineEndpoint}\n${composeDownExit}\n`),
  ]);
  if (preexisting) await writeFile(stateFile, "preexisting");

  try {
    const result = await runCommand("bash", [script], {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH}`,
      FAKE_DOCKER_LOG: logFile,
      FAKE_DOCKER_STATE: stateFile,
      FAKE_DOCKER_RM_EXIT: String(rmExit),
      FAKE_DOCKER_PRESERVE_AFTER_RM: preserveAfterRm ? "1" : "0",
      FAKE_NODE_EXIT: String(nodeExit),
    });
    return { ...result, dockerLog: await readFile(logFile, "utf8"), stateExists: await fileExists(stateFile) };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

test("FACT-45 database identity guard rejects the wrong database before writes", async () => {
  const previous = process.env.ORBITFLOW_FACT42_PROOF_DATABASE;
  process.env.ORBITFLOW_FACT42_PROOF_DATABASE = "orbitflow_fact42_proof";
  const queries = [];
  try {
    await assert.rejects(
      () => assertProofDatabase({
        query: async (sql) => {
          queries.push(sql);
          return { rows: [{ name: "another_database" }] };
        },
      }, "ORBITFLOW_FACT42_PROOF_DATABASE"),
      /DATABASE_URL must target ORBITFLOW_FACT42_PROOF_DATABASE/,
    );
    assert.deepEqual(queries, ["SELECT current_database() AS name"]);
  } finally {
    if (previous === undefined) delete process.env.ORBITFLOW_FACT42_PROOF_DATABASE;
    else process.env.ORBITFLOW_FACT42_PROOF_DATABASE = previous;
  }
});

for (const [script, containerName] of [
  ["scripts/fact-41-ticket-dispatch-proof.sh", "orbitfactory-fact41-postgres-proof"],
  ["scripts/fact-42-postgres-cutover-proof.sh", "orbitflow-fact42-postgres-proof"],
]) {
  test(`${containerName} preserves test status and reports cleanup failure`, async () => {
    const failedTest = await runProofScript(script, {
      nodeExit: 17,
      rmExit: 0,
      preserveAfterRm: false,
    });
    assert.equal(failedTest.code, 17);
    assert.equal(failedTest.stateExists, false);
    assert.match(failedTest.dockerLog, new RegExp(`container inspect ${containerName}`));

    const failedCleanup = await runProofScript(script, {
      nodeExit: 0,
      rmExit: 1,
      preserveAfterRm: true,
    });
    assert.equal(failedCleanup.code, 1);
    assert.equal(failedCleanup.stateExists, true);
    assert.match(failedCleanup.stderr, new RegExp(`Failed to remove disposable container: ${containerName}`));
    assert.match(failedCleanup.stderr, new RegExp(`Disposable container still exists after cleanup: ${containerName}`));
  });

  test(`${containerName} refuses a preexisting exact container`, async () => {
    const result = await runProofScript(script, {
      nodeExit: 0,
      rmExit: 0,
      preserveAfterRm: false,
      preexisting: true,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(`Refusing to touch existing container: ${containerName}`));
    assert.doesNotMatch(result.dockerLog, /^run /m);
  });
}

test("FACT-31 resolves Docker-assigned loopback ports after startup", async () => {
  const result = await runProofScript("scripts/fact-31-compose-proof.sh", {
    nodeExit: 0,
    rmExit: 0,
    preserveAfterRm: false,
  });
  assert.equal(result.code, 0);
  assert.match(result.dockerLog, /^compose .* port app 3000$/m);
  assert.match(result.dockerLog, /^compose .* port engine 3001$/m);
  assert.match(result.dockerLog, /^compose .* down --volumes --remove-orphans$/m);
});

for (const { service, port, appEndpoint, engineEndpoint } of [
  { service: "app", port: 3000, appEndpoint: "0.0.0.0:51001", engineEndpoint: "127.0.0.1:51002" },
  { service: "engine", port: 3001, appEndpoint: "127.0.0.1:51001", engineEndpoint: "127.0.0.1:70000" },
]) {
  test(`FACT-31 rejects an invalid ${service} published endpoint`, async () => {
    const result = await runProofScript("scripts/fact-31-compose-proof.sh", {
      nodeExit: 0,
      rmExit: 0,
      preserveAfterRm: false,
      appEndpoint,
      engineEndpoint,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(`FACT-31 proof expected ${service}:${port} to publish on a valid 127\\.0\\.0\\.1 port`));
    assert.match(result.dockerLog, new RegExp(`^compose .* port ${service} ${port}$`, "m"));
    assert.match(result.dockerLog, /^compose .* down --volumes --remove-orphans$/m);
  });
}

test("FACT-31 fails closed when its exact Compose cleanup fails", async () => {
  const result = await runProofScript("scripts/fact-31-compose-proof.sh", {
    nodeExit: 0,
    rmExit: 0,
    preserveAfterRm: false,
    composeDownExit: 1,
  });
  assert.equal(result.code, 1);
  assert.match(result.dockerLog, /^compose .* down --volumes --remove-orphans$/m);
});
