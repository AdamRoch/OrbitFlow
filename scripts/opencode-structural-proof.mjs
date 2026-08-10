import { execFileSync } from "node:child_process";
import { createOpenCodeAdapter } from "../coding-adapter/src/openCodeAdapter.js";

// This is deliberately credential-free. It verifies that the image which owns
// the FACT-3 adapter has Git available, then exercises the adapter's fail-fast
// missing-credential contract without starting OpenCode or making a provider
// request.
execFileSync("git", ["--version"], {
  stdio: "ignore",
  env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
});

const adapter = createOpenCodeAdapter({
  env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
});

try {
  await adapter.delegate_coding_task("structural proof only", "/not-used");
  throw new Error("adapter accepted a missing credential");
} catch (error) {
  if (error?.code !== "missing_credentials" || error?.varName !== "OPENROUTER_API_KEY") {
    throw error;
  }
}

process.stdout.write("OpenCode adapter missing-credential contract verified\n");
