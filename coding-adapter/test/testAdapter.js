import { fileURLToPath } from "node:url";
import { createOpenCodeAdapter } from "../src/openCodeAdapter.js";

export const TEST_CREDENTIAL = "or-secret-1234567890";
export const FAKE_OPENCODE = fileURLToPath(
  new URL("../fixtures/fake-opencode.mjs", import.meta.url),
);
export const HANGING_OPENCODE = fileURLToPath(
  new URL("../fixtures/hanging-opencode.mjs", import.meta.url),
);

export function fakeOpenCodeAdapter(options = {}) {
  return createOpenCodeAdapter({
    binary: FAKE_OPENCODE,
    env: { OPENROUTER_API_KEY: TEST_CREDENTIAL, PATH: process.env.PATH },
    ...options,
  });
}
