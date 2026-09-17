import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "../src/shared/types.js";
import {
  aggregateRuntimeUsage,
  nativeTools,
  observeAssistantCost,
  runtimeConfig,
  RuntimeFailure,
  validateArtifactName,
} from "../src/server/runtime.js";

const agent = (tools: Agent["tools"]): Agent => ({
  id: "builder",
  name: "Builder",
  role: "Builder",
  systemPrompt: "Build the requested static browser application.",
  model: "openai/test-model",
  tools,
  memory: [],
  skills: [],
  approval: "publish",
  guardrails: {
    maxCostUsd: 1,
    maxTurns: 4,
    callsPerHour: 10,
    blockedActions: [],
  },
  schedule: {
    enabled: false,
    expression: "@every 1h",
    prompt: "",
    workflowId: null,
  },
  telegram: false,
});

test("artifact paths reject runtime instructions at every depth", () => {
  for (const path of [
    "opencode.json",
    "config/opencode.jsonc",
    "AGENTS.md",
    "src/agents.md",
    "CLAUDE.md",
    "nested/claude.md",
    ".opencode/plugins/escape.js",
  ])
    assert.throws(
      () => validateArtifactName(path),
      /runtime instructions|hidden/,
    );
  assert.doesNotThrow(() => validateArtifactName("src/app.js"));
  assert.doesNotThrow(() => validateArtifactName("package.json"));
});

test("runtime config denies instruction files after extension allows", () => {
  const config = runtimeConfig(agent(["write", "edit"]));
  const permissions = config.agent["orbitflow-agent"].permission.edit;
  if (typeof permissions !== "object")
    assert.fail("Expected path-specific edit permissions");
  assert.equal(permissions["*.json"], "allow");
  assert.equal(permissions["opencode.json"], "deny");
  assert.equal(permissions["*/opencode.jsonc"], "deny");
  assert.equal(permissions["AGENTS.md"], "deny");
  assert.equal(permissions["*/CLAUDE.md"], "deny");
});

test("prompt tool selection preserves write and edit as separate controls", () => {
  const writeOnly = nativeTools(agent(["read", "write"]));
  assert.equal(writeOnly.read, true);
  assert.equal(writeOnly.write, true);
  assert.equal(writeOnly.edit, false);
  assert.equal(writeOnly.bash, false);
  assert.equal(writeOnly.webfetch, false);
  assert.equal(writeOnly.StructuredOutput, true);

  const editOnly = nativeTools(agent(["edit", "glob", "grep"]));
  assert.equal(editOnly.write, false);
  assert.equal(editOnly.edit, true);
  assert.equal(editOnly.glob, true);
  assert.equal(editOnly.grep, true);
});

test("workflow turn limits do not inject an assistant prefill into native tool cycles", () => {
  const configured = runtimeConfig(agent(["read"]));
  assert.equal("steps" in configured.agent["orbitflow-agent"], false);
});

test("runtime prompt guides efficient native file inspection", () => {
  const configured = runtimeConfig(agent(["read", "grep"]));
  assert.match(
    configured.agent["orbitflow-agent"].prompt,
    /large files in broad 300–500-line ranges with targeted grep/,
  );
});

test("usage aggregation becomes unknown when any assistant cost is missing", () => {
  assert.deepEqual(
    aggregateRuntimeUsage([
      { info: { role: "user" } },
      {
        info: {
          role: "assistant",
          cost: 0.1,
          tokens: {
            input: 10,
            output: 4,
            reasoning: 3,
            cache: { read: 20, write: 5 },
          },
        },
      },
      {
        info: {
          role: "assistant",
          tokens: {
            input: 6,
            output: 2,
            reasoning: 1,
            cache: { read: 8, write: 2 },
          },
        },
      },
    ]),
    { costUsd: null, inputTokens: 51, outputTokens: 10 },
  );

  assert.deepEqual(
    aggregateRuntimeUsage([
      {
        info: {
          role: "assistant",
          cost: 0,
          tokens: {
            input: 3,
            output: 1,
            reasoning: 2,
            cache: { read: 9, write: 4 },
          },
        },
      },
      {
        info: {
          role: "assistant",
          cost: 0.25,
          tokens: {
            input: 7,
            output: 5,
            reasoning: 1,
            cache: { read: 6, write: 2 },
          },
        },
      },
    ]),
    { costUsd: 0.25, inputTokens: 31, outputTokens: 9 },
  );

  assert.deepEqual(aggregateRuntimeUsage([]), {
    costUsd: null,
    inputTokens: 0,
    outputTokens: 0,
  });
});

test("runtime failures retain measured usage for the engine", () => {
  const failure = new RuntimeFailure("provider failed", {
    costUsd: 0.2,
    inputTokens: 12,
    outputTokens: 3,
  });
  assert.equal(failure.name, "RuntimeFailure");
  assert.deepEqual(failure.usage, {
    costUsd: 0.2,
    inputTokens: 12,
    outputTokens: 3,
  });
});

test("observed assistant costs replace streaming snapshots without double counting", () => {
  const costs = new Map<string, number>();
  const event = (id: string, cost: number, sessionID = "session-1") => ({
    type: "message.updated",
    properties: { info: { id, sessionID, role: "assistant", cost } },
  });

  assert.equal(observeAssistantCost(costs, event("a", 0.1), "session-1"), 0.1);
  assert.equal(observeAssistantCost(costs, event("a", 0.2), "session-1"), 0.2);
  assert.equal(observeAssistantCost(costs, event("b", 0.3), "session-1"), 0.5);
  assert.equal(observeAssistantCost(costs, event("c", 9, "other"), "session-1"), null);
  assert.equal(costs.size, 2);
});
