import assert from "node:assert/strict";
import test from "node:test";

import {
  PLATFORM_TOOL_PAYLOAD,
  buildPlatformToolEvidence,
  composePlatformToolPrompt,
  parsePlatformToolAgentOutput,
  parsePlatformToolAudit,
  parsePlatformToolTurn,
  validatePlatformToolInvocation,
  validatePlatformToolWorkspaceInjection,
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

test("platform tool proof requires complete TOOLS.md injection metadata", () => {
  const injectedWorkspaceFiles = [
    {
      name: "TOOLS.md",
      missing: false,
      truncated: false,
      rawChars: 120,
      injectedChars: 120,
    },
  ];
  assert.deepEqual(validatePlatformToolWorkspaceInjection(injectedWorkspaceFiles), {
    toolsMdInjectedCompletely: true,
  });
  assert.throws(
    () =>
      validatePlatformToolWorkspaceInjection(
        injectedWorkspaceFiles.map((file) => ({ ...file, truncated: true, injectedChars: 80 })),
      ),
    /complete TOOLS\.md workspace injection/,
  );
  assert.throws(() => validatePlatformToolWorkspaceInjection([]), /complete TOOLS\.md workspace injection/);
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

test("platform tool evidence retains only bounded registration and acceptance facts", () => {
  const evidence = buildPlatformToolEvidence({
    normalizedTurn: {
      completion: { status: "ok", exitCode: 0 },
      usage: { input: 10, output: 8, total: 18 },
    },
    invocationValidation: validatePlatformToolInvocation([auditEntry]),
    workspaceInjection: { toolsMdInjectedCompletely: true },
  });
  assert.deepEqual(Object.keys(evidence), ["schemaVersion", "ticket", "registration", "acceptanceCriteria"]);
  assert.deepEqual(evidence.registration.workspaceInstruction, {
    name: "TOOLS.md",
    injectedCompletely: true,
  });
  assert.equal(evidence.acceptanceCriteria.toolsMdInjectedThroughOpenClaw.passed, true);
  assert.equal(Object.hasOwn(evidence, "workspace"), false);
  assert.equal(Object.hasOwn(evidence, "turn"), false);
  assert.equal(Object.hasOwn(evidence, "findings"), false);
  assert.equal(Object.hasOwn(evidence, "environment"), false);
});
