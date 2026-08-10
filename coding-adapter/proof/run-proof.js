#!/usr/bin/env node
// Real evaluator-runnable proof of delegate_coding_task.
//
// Usage:
//   cd coding-adapter
//   npm ci
//   OPENROUTER_API_KEY=<key> npm run prove -- ["task text"]

import { execFileSync } from "node:child_process";
import {
  createOpenCodeAdapter,
  OPEN_CODE_BINARY,
  OPEN_CODE_VERSION,
} from "../src/openCodeAdapter.js";
import {
  createIsolatedGitWorkspace,
  removeIsolatedGitWorkspace,
} from "../src/workspace.js";

const TASK =
  process.argv[2] ||
  "Create a file named hello.txt containing exactly the text: hello from the OrbitFlow coding adapter spike";

async function main() {
  const actualVersion = execFileSync(OPEN_CODE_BINARY, ["--version"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
  }).trim();
  if (actualVersion !== OPEN_CODE_VERSION) {
    throw new Error(`expected opencode ${OPEN_CODE_VERSION}, received ${actualVersion}`);
  }

  const adapter = createOpenCodeAdapter();
  const workspace = await createIsolatedGitWorkspace();
  try {
    const { diff, log, usage } = await adapter.delegate_coding_task(TASK, workspace);
    console.log(`opencode version: ${actualVersion}`);
    console.log("\n--- usage ---");
    console.log(JSON.stringify(usage, null, 2));
    console.log("\n--- diff ---");
    console.log(diff || "(empty diff)");
    console.log("\n--- log (bounded, tail) ---");
    console.log(log);
  } finally {
    await removeIsolatedGitWorkspace(workspace);
  }
}

main().catch((err) => {
  const credential = process.env.OPENROUTER_API_KEY;
  const message = credential
    ? String(err?.message ?? err).split(credential).join("[REDACTED]")
    : String(err?.message ?? err);
  console.error(`proof failed: [${err?.code ?? err?.name ?? "Error"}] ${message}`);
  process.exitCode = 1;
});
