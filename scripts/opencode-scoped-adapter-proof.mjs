import { createOpenCodeAdapter } from "../coding-adapter/src/openCodeAdapter.js";
import {
  createIsolatedGitWorkspace,
  removeIsolatedGitWorkspace,
} from "../coding-adapter/src/workspace.js";
import { fileURLToPath } from "node:url";

if (typeof process.env.OPENROUTER_API_KEY !== "string" || process.env.OPENROUTER_API_KEY.length === 0) {
  throw new Error("OPENROUTER_API_KEY did not reach the ephemeral coding-adapter invocation");
}

const workspace = await createIsolatedGitWorkspace({ prefix: "fact7-scoped-adapter-" });
try {
  const adapter = createOpenCodeAdapter({
    binary: fileURLToPath(new URL("./fact-7-fake-opencode.mjs", import.meta.url)),
    env: {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      PATH: process.env.PATH,
    },
  });
  const result = await adapter.delegate_coding_task("structural proof only", workspace);
  if (result.usage.costUsd !== 0) throw new Error("fake adapter child reported nonzero cost");
} finally {
  await removeIsolatedGitWorkspace(workspace);
}

process.stdout.write("Scoped OpenCode adapter child credential proof verified\n");
