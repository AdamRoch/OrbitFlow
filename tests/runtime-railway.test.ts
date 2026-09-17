import assert from "node:assert/strict";
import test from "node:test";
import type { Sandbox, CreateOptions, ExecOptions, ExecHandle } from "railway";
import type { Agent } from "../src/shared/types.js";
import { createRunnerFrameParser } from "../src/server/runtime-railway.js";
import { executeRailwayTurn } from "../src/server/runtime-railway.js";
import { RuntimeFailure } from "../src/server/runtime.js";

const agent: Agent = {
  id: "agent-1",
  name: "Reviewer",
  role: "Reviewer",
  systemPrompt: "Inspect source and decide.",
  model: "openrouter/openai/test-model",
  tools: ["read", "grep"],
  memory: [],
  skills: [],
  approval: "publish",
  guardrails: { maxCostUsd: 1, maxTurns: 2, callsPerHour: 10, blockedActions: [] },
  schedule: { enabled: false, expression: "@every 1h", prompt: "", workflowId: null },
  telegram: false,
};

async function withStubSettings(run: () => Promise<void>) {
  const names = [
    "ORBITFLOW_SANDBOX_CHECKPOINT",
    "RAILWAY_TOKEN",
    "RAILWAY_ENVIRONMENT_ID",
    "OPENROUTER_API_KEY",
  ];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.ORBITFLOW_SANDBOX_CHECKPOINT = "transport-stub-checkpoint";
  process.env.RAILWAY_TOKEN = "transport-stub-project-token";
  process.env.RAILWAY_ENVIRONMENT_ID = "transport-stub-environment";
  process.env.OPENROUTER_API_KEY = "transport-stub-provider-key";
  try {
    await run();
  } finally {
    for (const name of names) {
      const value = prior[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("Railway runner frames survive arbitrary stdout chunk boundaries", () => {
  const frames: unknown[] = [];
  const parser = createRunnerFrameParser((frame) => frames.push(frame));
  parser.push('{"type":"event","event":{"kind":"status","content":"Starting"}}\n{"type":"res');
  parser.push('ult","result":{"summary":"done","outcome":"approved","files":{},"costUsd":0.1,"inputTokens":10,"outputTokens":2}}\n');
  parser.finish();
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], {
    type: "event",
    event: { kind: "status", content: "Starting" },
  });
  assert.equal((frames[1] as { type: string }).type, "result");
});

test("Railway runner protocol rejects incomplete frames", () => {
  const parser = createRunnerFrameParser(() => undefined);
  assert.throws(() => parser.push('{"type":"result"}\n'), /incomplete frame/);
  const partial = createRunnerFrameParser(() => undefined);
  partial.push('{"type":"failure"');
  assert.throws(() => partial.finish(), /incomplete frame/);
});

test("transport stub: abort after Sandbox creation destroys exact VM before file transfer or exec", async () => {
  await withStubSettings(async () => {
    const controller = new AbortController();
    const actions: string[] = [];
    const sandbox = {
      id: "transport-stub-sandbox-1",
      files: { write: async () => actions.push("write") },
      exec: () => {
        actions.push("exec");
        throw new Error("exec must not start after abort");
      },
      destroy: async () => { actions.push("destroy:transport-stub-sandbox-1"); },
    } as unknown as Sandbox;
    await assert.rejects(
      executeRailwayTurn(
        {
          id: "run-1",
          agent,
          prompt: "Inspect source",
          files: { "index.html": "<main>test</main>" },
          maxCostUsd: 1,
          signal: controller.signal,
        },
        {
          createSandbox: async (name, options: CreateOptions) => {
            assert.equal(name, "transport-stub-checkpoint");
            assert.equal(options.networkIsolation, "ISOLATED");
            assert.deepEqual(options.env, { OPENROUTER_API_KEY: "transport-stub-provider-key" });
            controller.abort();
            return sandbox;
          },
        },
      ),
      (error: unknown) =>
        error instanceof RuntimeFailure &&
        error.message === "Runtime turn aborted" &&
        error.usage.costUsd === 0,
    );
    assert.deepEqual(actions, ["destroy:transport-stub-sandbox-1"]);
  });
});

test("transport stub: runner failure retains usage and destroys exact VM", async () => {
  await withStubSettings(async () => {
    const actions: string[] = [];
    const sandbox = {
      id: "transport-stub-sandbox-2",
      files: { write: async (path: string, _data: string, options: { mode: number }) => {
        actions.push(`write:${path}:${options.mode.toString(8)}`);
      } },
      exec: (_command: string, options: ExecOptions) => {
        actions.push("exec");
        options.onStdout?.('{"type":"failure","message":"native tool failed","usage":{"costUsd":0.12,"inputTokens":20,"outputTokens":3}}\n');
        const handle = Object.assign(
          Promise.resolve({ exitCode: 1, stdout: "", stderr: "", truncated: false, timedOut: false }),
          { kill: async () => true },
        );
        return handle as unknown as ExecHandle;
      },
      destroy: async () => { actions.push("destroy:transport-stub-sandbox-2"); },
    } as unknown as Sandbox;
    await assert.rejects(
      executeRailwayTurn(
        {
          id: "run-2",
          agent,
          prompt: "Inspect source",
          files: { "index.html": "<main>test</main>" },
          maxCostUsd: 1,
        },
        { createSandbox: async () => sandbox },
      ),
      (error: unknown) =>
        error instanceof RuntimeFailure &&
        error.message === "native tool failed" &&
        error.usage.costUsd === 0.12 &&
        error.usage.inputTokens === 20,
    );
    assert.deepEqual(actions, [
      "write:/runtime/input.json:600",
      "exec",
      "destroy:transport-stub-sandbox-2",
    ]);
  });
});
