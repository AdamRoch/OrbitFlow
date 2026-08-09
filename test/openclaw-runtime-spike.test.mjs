import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenClawContractError,
  parseCommandJson,
  parseCliJson,
  parseOutputContract,
  parseTurnResult,
} from "../src/runtime/openclaw-runtime-spike.mjs";

const outputContract = JSON.stringify({
  artifact: {
    agent: "Mira",
    persona: "skeptical systems scout",
    memory_fact: "amber-lattice",
    observation: "The structured surface completed.",
  },
  handoff_brief: "Use the structured result.",
  events: [],
});

test("parseCliJson ignores OpenClaw diagnostic preamble and parses the JSON document", () => {
  const parsed = parseCliJson(`[agents/auth-profiles] synced credentials\n${JSON.stringify({ ok: true })}\n`);
  assert.deepEqual(parsed, { ok: true });
});

test("parseCliJson accepts top-level arrays after bracketed diagnostics", () => {
  const parsed = parseCliJson('[agents/auth-profiles] synced credentials\n[{"id":"fact-scout"}]\n');
  assert.deepEqual(parsed, [{ id: "fact-scout" }]);
});

test("parseCommandJson falls back to stderr for OpenClaw 2026.4.15 agent JSON", () => {
  const parsed = parseCommandJson({
    stdout: "",
    stderr: '[agents/auth-profiles] synced credentials\n{"payloads":[]}',
  });
  assert.deepEqual(parsed, { payloads: [] });
});

test("parseOutputContract accepts one JSON fence without scraping surrounding prose", () => {
  const parsed = parseOutputContract(`\`\`\`json\n${outputContract}\n\`\`\``);
  assert.equal(parsed.artifact.agent, "Mira");
  assert.throws(() => parseOutputContract(`Here is the result:\n\`\`\`json\n${outputContract}\n\`\`\``));
});

test("parseTurnResult accepts a completed OpenClaw 2026.4.15 envelope", () => {
  const envelope = {
    payloads: [{ text: outputContract }],
    meta: {
      livenessState: "idle",
      aborted: false,
      stopReason: "stop",
      completion: { finishReason: "stop" },
      agentMeta: {
        sessionId: "session-1",
        provider: "openrouter",
        model: "openai/gpt-4.1-mini",
        lastCallUsage: { input: 100, output: 30, total: 130 },
      },
    },
  };
  const result = parseTurnResult({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify(envelope),
    stderr: "",
  });
  assert.equal(result.completion.status, "stop");
  assert.equal(result.usage.total, 130);
  assert.equal(result.output.artifact.memory_fact, "amber-lattice");
});

test("parseTurnResult rejects OpenClaw's false zero-exit error envelope", () => {
  const envelope = {
    payloads: [{ text: "Context overflow" }],
    meta: {
      livenessState: "blocked",
      error: { kind: "context_overflow", message: "HTML 404" },
      agentMeta: { lastCallUsage: { input: 0, output: 0, total: 0 } },
    },
  };
  assert.throws(
    () =>
      parseTurnResult({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify(envelope),
        stderr: "",
      }),
    (error) =>
      error instanceof OpenClawContractError &&
      error.details.livenessState === "blocked" &&
      error.details.error === "context_overflow",
  );
});

test("parseTurnResult rejects a timeout before parsing output", () => {
  assert.throws(
    () =>
      parseTurnResult({
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        stdout: "",
        stderr: "",
      }),
    /timed out/,
  );
});

test("parseTurnResult accepts the current official stable agent exec envelope", () => {
  const result = parseTurnResult({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stderr: "",
    stdout: JSON.stringify({
      ok: true,
      status: "ok",
      final: outputContract,
      payloads: [{ text: outputContract }],
      usage: { input: 20, output: 10, total: 30 },
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
      sessionId: "session-2",
    }),
  });
  assert.equal(result.completion.status, "ok");
  assert.equal(result.usage.total, 30);
});
