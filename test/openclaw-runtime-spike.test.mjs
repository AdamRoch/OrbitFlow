import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_DEFINITIONS,
  OpenClawContractError,
  evaluateOpenRouterDiagnostic,
  parseCommandJson,
  parseCliJson,
  parseOpenAiRequestLog,
  parseOutputContract,
  parseTurnResult,
  validateAgentProof,
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

test("parseOpenAiRequestLog retains only authoritative request metadata", () => {
  const request = parseOpenAiRequestLog({
    stdout: "",
    stderr:
      "[log_123456] POST https://openrouter.ai/api/v1/chat/completions succeeded with status 200 in 42ms\n",
  });
  assert.deepEqual(request, {
    method: "POST",
    origin: "https://openrouter.ai",
    path: "/api/v1/chat/completions",
    httpStatus: 200,
    outcome: "succeeded",
  });
});

test("validateAgentProof binds output to the configured identity, theme, memory, and files", () => {
  const injectedWorkspaceFiles = ["IDENTITY.md", "MEMORY.md", "SOUL.md"].map((name) => ({
    name,
    missing: false,
    truncated: false,
    rawChars: 20,
    injectedChars: 20,
  }));
  const validation = validateAgentProof({
    agent: AGENT_DEFINITIONS[0],
    output: JSON.parse(outputContract),
    injectedWorkspaceFiles,
  });
  assert.deepEqual(validation, {
    agentIdentity: true,
    personaTheme: true,
    persistentMemory: true,
    completeWorkspaceInjection: true,
  });
  assert.throws(
    () =>
      validateAgentProof({
        agent: AGENT_DEFINITIONS[0],
        output: {
          ...JSON.parse(outputContract),
          artifact: { ...JSON.parse(outputContract).artifact, agent: "Rowan" },
        },
        injectedWorkspaceFiles,
      }),
    /agentIdentity/,
  );
  assert.throws(
    () =>
      validateAgentProof({
        agent: AGENT_DEFINITIONS[0],
        output: JSON.parse(outputContract),
        injectedWorkspaceFiles: injectedWorkspaceFiles.map((file) =>
          file.name === "SOUL.md" ? { ...file, truncated: true, injectedChars: 10 } : file,
        ),
      }),
    /completeWorkspaceInjection/,
  );
});

test("evaluateOpenRouterDiagnostic requires one changed condition and both real inferences", () => {
  const configuration = {
    modelsMode: "replace",
    provider: "openrouter",
    api: "openai-completions",
  };
  const diagnostic = {
    credentialSource: "OPENROUTER_API_KEY",
    credentialValueRetained: false,
    observedGeneratedBaseUrl: "https://openrouter.ai/v1",
    controlledComparison: { startingStateSha256: "a".repeat(64) },
    authProfile: { credentialSource: "OPENROUTER_API_KEY" },
    directProviderRequest: {
      origin: "https://openrouter.ai",
      path: "/api/v1/chat/completions",
      requestedModel: "openai/gpt-4.1-mini",
      responseModel: "openai/gpt-4.1-mini",
      httpStatus: 200,
      output: "OK",
      usage: { totalTokens: 16 },
    },
    openClawBeforeCorrection: {
      configuration: { ...configuration, baseUrl: "https://openrouter.ai/v1" },
      request: { path: "/v1/chat/completions", httpStatus: 404 },
      runtime: {
        provider: "openrouter",
        model: "openai/gpt-4.1-mini",
        authMode: "auth-profile",
        authProfile: {
          profileId: "openrouter:default",
          credentialSource: "OPENROUTER_API_KEY",
        },
      },
      result: { completed: false, output: null },
    },
    openClawAfterCorrection: {
      configuration: { ...configuration, baseUrl: "https://openrouter.ai/api/v1" },
      request: { path: "/api/v1/chat/completions", httpStatus: 200 },
      runtime: {
        provider: "openrouter",
        model: "openai/gpt-4.1-mini",
        authMode: "auth-profile",
        authProfile: {
          profileId: "openrouter:default",
          credentialSource: "OPENROUTER_API_KEY",
        },
      },
      result: { completed: true, output: "OK" },
    },
  };
  assert.ok(Object.values(evaluateOpenRouterDiagnostic(diagnostic)).every(Boolean));
  diagnostic.openClawAfterCorrection.configuration.modelsMode = "merge";
  assert.equal(evaluateOpenRouterDiagnostic(diagnostic).oneChangedCondition, false);
});
