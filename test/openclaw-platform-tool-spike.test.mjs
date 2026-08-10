import assert from "node:assert/strict";
import test from "node:test";

import {
  PLATFORM_TOOL_PAYLOAD,
  composePlatformToolPrompt,
  parsePlatformToolAgentOutput,
  parsePlatformToolAudit,
  parsePlatformToolTurn,
  validatePlatformToolInvocation,
} from "../src/runtime/openclaw-platform-tool-spike.mjs";

const agentOutput = JSON.stringify({
  called: "orbit-tool",
  payload: PLATFORM_TOOL_PAYLOAD,
  result: "The platform CLI completed.",
});

const auditEntry = {
  schemaVersion: 1,
  source: "orbit-tool",
  command: "orbit-tool",
  subcommand: "echo",
  payload: PLATFORM_TOOL_PAYLOAD,
  args: ["echo", PLATFORM_TOOL_PAYLOAD],
};

test("platform tool audit preserves command and exact arguments as structured data", () => {
  const entries = parsePlatformToolAudit(`${JSON.stringify(auditEntry)}\n`);
  assert.deepEqual(validatePlatformToolInvocation(entries), {
    schemaVersion: true,
    source: true,
    command: true,
    subcommand: true,
    payload: true,
    exactArguments: true,
  });
});

test("platform tool audit rejects a mismatched payload and terminal-text substitutes", () => {
  assert.throws(
    () => validatePlatformToolInvocation([{ ...auditEntry, payload: "invented", args: ["echo", "invented"] }]),
    /payload/,
  );
  assert.throws(() => parsePlatformToolAudit("orbit-tool echo fact-2-platform-tool-payload\n"), /invalid JSON/);
});

test("platform tool turn requires a successful structured envelope and strict agent acknowledgement", () => {
  const parsed = parsePlatformToolTurn({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stderr: "",
    stdout: JSON.stringify({
      ok: true,
      status: "ok",
      final: agentOutput,
      usage: { input: 10, output: 8, total: 18 },
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
      sessionId: "tool-session",
    }),
  });
  assert.equal(parsed.output.called, "orbit-tool");
  assert.equal(parsed.usage.total, 18);
  assert.throws(() => parsePlatformToolAgentOutput("called orbit-tool"), /strict JSON/);
});

test("platform tool prompt mandates one exact CLI command", () => {
  const prompt = composePlatformToolPrompt();
  assert.match(prompt, /node \.\/orbit-tool\.mjs echo fact-2-platform-tool-payload/);
  assert.match(prompt, /Do not simulate the call/);
});
