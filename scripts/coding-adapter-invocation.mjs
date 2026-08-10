import { createOpenCodeAdapter } from "../coding-adapter/src/openCodeAdapter.js";
import {
  createIsolatedGitWorkspace,
  removeIsolatedGitWorkspace,
} from "../coding-adapter/src/workspace.js";

const [task] = process.argv.slice(2);
const binary = process.env.ORBITFACTORY_CODING_ADAPTER_BINARY;

if (typeof task !== "string" || task.length === 0) {
  throw new Error("usage: docker compose --profile coding-adapter run --rm coding-adapter '<task>'");
}

// P2-4 will own workspace lifecycle in the product engine. This compose-only
// boundary remains intentionally one-shot, but uses the existing adapter's
// isolated workspace and minimal child environment without widening that API.
const workspace = await createIsolatedGitWorkspace({ prefix: "orbitflow-compose-adapter-" });
try {
  const adapter = createOpenCodeAdapter({
    ...(typeof binary === "string" && binary.length > 0 ? { binary } : {}),
    env: {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      PATH: process.env.PATH,
    },
  });
  const result = await adapter.delegate_coding_task(task, workspace);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await removeIsolatedGitWorkspace(workspace);
}
