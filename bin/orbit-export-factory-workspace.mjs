#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

try {
  const { values: { "run-id": runId, destination: requestedDestination } } = parseArgs({
    options: { "run-id": { type: "string" }, destination: { type: "string" } },
    strict: true,
  });
  if (!/^[1-9]\d*$/.test(runId ?? "")) throw new Error("--run-id must be a positive integer");
  if (!requestedDestination) throw new Error("--destination is required");
  if (!path.isAbsolute(requestedDestination)) {
    throw new Error("--destination must be an absolute host path");
  }
  if (/[\0\r\n:]/.test(requestedDestination)) {
    throw new Error("--destination contains characters unsafe for a Docker bind mount");
  }
  const destination = path.resolve(requestedDestination);
  const stat = await lstat(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(destination)) !== destination) {
    throw new Error("--destination must be an existing real directory, not a symlinked path");
  }

  const expectedName = `factory-run-${runId}`;
  const output = await runDockerCompose({
    destination,
    runId,
    owner: `${process.getuid()}:${process.getgid()}`,
  });
  if (output.trim() !== expectedName) {
    throw new Error("workspace exporter returned an unexpected result path");
  }
  process.stdout.write(`${path.join(destination, expectedName)}\n`);
} catch (error) {
  process.stderr.write(`Export refused: ${error?.message ?? "unknown error"}\n`);
  process.exitCode = 1;
}

function runDockerCompose({ destination, runId, owner }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "--project-directory", repositoryRoot,
        "--file", path.join(repositoryRoot, "compose.yaml"),
        "run", "--rm", "--no-deps",
        "--entrypoint", "node",
        "--volume", `${destination}:/orbitflow-export`,
        "tool-broker",
        "/app/bin/orbit-export-factory-workspace-container.mjs",
        "--run-id", runId,
        "--owner", owner,
      ],
      { cwd: repositoryRoot, env: process.env, stdio: ["ignore", "pipe", "inherit"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", (error) => reject(new Error(`could not start Docker Compose: ${error.message}`)));
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Docker Compose workspace export exited with status ${code}`));
    });
  });
}
