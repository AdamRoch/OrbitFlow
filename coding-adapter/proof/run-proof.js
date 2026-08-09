#!/usr/bin/env node
// Real evaluator-runnable proof of delegate_coding_task.
//
// Usage:
//   OPENROUTER_API_KEY=<key> node coding-adapter/proof/run-proof.js ["task text"]
//
// Runs fully headless, no TTY, no interactive prompts. Never prints the
// value of OPENROUTER_API_KEY or any other secret -- only its presence is
// checked.

import { createOpenCodeAdapter } from "../src/openCodeAdapter.js";
import { createIsolatedGitWorkspace } from "../src/workspace.js";

const TASK =
  process.argv[2] ||
  "Create a file named hello.txt containing exactly the text: hello from the OrbitFlow coding adapter spike";

async function main() {
  const adapter = createOpenCodeAdapter({});
  const workspace = await createIsolatedGitWorkspace();
  console.log(`workspace: ${workspace}`);
  console.log(`task: ${TASK}`);

  try {
    const { diff, log, usage } = await adapter.delegate_coding_task(TASK, workspace);
    console.log("\n--- usage ---");
    console.log(JSON.stringify(usage, null, 2));
    console.log("\n--- diff ---");
    console.log(diff || "(empty diff)");
    console.log("\n--- log (bounded, tail) ---");
    console.log(log);
  } catch (err) {
    console.error(`\ndelegate_coding_task failed: [${err.code ?? err.name}] ${err.message}`);
    process.exitCode = 1;
  }
}

main();
