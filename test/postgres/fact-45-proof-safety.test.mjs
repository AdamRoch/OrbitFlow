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

printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
command="\${1:-}"
subcommand="\${2:-}"

if [[ "$command" == "container" && "$subcommand" == "inspect" ]]; then
  [[ -f "$FAKE_DOCKER_STATE" ]]
  exit $?
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

async function runProofScript(script, { nodeExit, rmExit, preserveAfterRm, preexisting = false }) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "orbitflow-fact45-shell-"));
  const binDirectory = path.join(temporaryRoot, "bin");
  const stateFile = path.join(temporaryRoot, "container-state");
  const logFile = path.join(temporaryRoot, "docker.log");
  await mkdir(binDirectory);
  const dockerPath = path.join(binDirectory, "docker");
  const nodePath = path.join(binDirectory, "node");
  await writeFile(dockerPath, fakeDockerScript);
  await writeFile(nodePath, fakeNodeScript);
  await Promise.all([chmod(dockerPath, 0o755), chmod(nodePath, 0o755)]);
  await writeFile(logFile, "");
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
