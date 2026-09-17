import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, Run, RunDetail } from "../src/shared/types.js";
import {
  advanceTelegramOffset,
  createOutboxDrain,
  everyIntervalMs,
  isAuthorizedChat,
  listScheduleStatuses,
  nextScheduleWake,
  parseTelegramCommand,
  selectGuidedImprove,
  startIntegrations,
  telegramStatusText,
} from "../src/server/integrations.js";

test("conversational completion does not claim a missing preview", () => {
  const now = new Date().toISOString();
  const run: Run = {
    id: "conversation-run",
    workflowId: null,
    agentId: "assistant",
    prompt: "Remember my name",
    status: "completed",
    currentNode: null,
    createdAt: now,
    updatedAt: now,
    costUsd: 0.007,
    inputTokens: 10,
    outputTokens: 20,
    error: null,
    revisionId: null,
    parentRunId: null,
    steps: 1,
  };
  const detail: RunDetail = {
    run,
    messages: [
      {
        id: "reply",
        runId: run.id,
        from: "assistant",
        to: "human",
        content: "I remember that your name is Adam.",
        kind: "result",
        createdAt: now,
      },
    ],
    events: [],
    revisions: [],
    executionSnapshot: { agents: [], workflow: null },
  };
  assert.doesNotMatch(telegramStatusText(detail), /source and preview/);
  assert.match(
    telegramStatusText({
      ...detail,
      run: { ...run, revisionId: "revision-1" },
    }),
    /source and preview/,
  );
});

test("transport stub: overlapping outbox flushes share one send", async () => {
  let sends = 0;
  let release!: () => void;
  const transport = new Promise<void>((resolve) => {
    release = resolve;
  });
  const flush = createOutboxDrain(async () => {
    sends++;
    await transport;
  });
  const first = flush();
  const second = flush();
  assert.equal(sends, 1);
  assert.strictEqual(first, second);
  release();
  await Promise.all([first, second]);
  await flush();
  assert.equal(sends, 2);
});

test("parses Telegram chat and workflow commands", () => {
  assert.deepEqual(parseTelegramCommand("please improve the app"), {
    kind: "chat",
    prompt: "please improve the app",
  });
  assert.deepEqual(
    parseTelegramCommand("/build build Create a workout tracker"),
    { kind: "build", workflowId: "build", prompt: "Create a workout tracker" },
  );
  assert.deepEqual(
    parseTelegramCommand("/improve improve run-12 duplicate routines"),
    {
      kind: "improve",
      arguments: ["improve", "run-12", "duplicate", "routines"],
    },
  );
  assert.deepEqual(parseTelegramCommand("/improve"), {
    kind: "improve",
    arguments: [],
  });
  assert.deepEqual(parseTelegramCommand("/improve Add duplicate routine"), {
    kind: "improve",
    arguments: ["Add", "duplicate", "routine"],
  });
  assert.deepEqual(
    parseTelegramCommand("/approve@orbitflow_bot run-12 token-7"),
    { kind: "approve", runId: "run-12", approvalToken: "token-7" },
  );
  assert.deepEqual(
    parseTelegramCommand("/reject run-12 token-7 Missing keyboard support"),
    {
      kind: "reject",
      runId: "run-12",
      approvalToken: "token-7",
      feedback: "Missing keyboard support",
    },
  );
  assert.deepEqual(parseTelegramCommand("/status run-12"), {
    kind: "status",
    runId: "run-12",
  });
  assert.deepEqual(parseTelegramCommand("/start@orbitflow_bot"), {
    kind: "help",
  });
});

test("transport stub: guided improve selects one workflow and latest approved app", async () => {
  const query = async <T>(sql: string): Promise<T[]> => {
    if (sql.startsWith("SELECT data FROM workflows"))
      return [{ data: { id: "loaded-improve" } }] as T[];
    if (sql.startsWith("SELECT r.data FROM runs"))
      return [{ data: { id: "approved-app" } }] as T[];
    throw new Error(`Unexpected SQL in transport stub: ${sql}`);
  };
  assert.deepEqual(await selectGuidedImprove(query), {
    workflowId: "loaded-improve",
    parentRunId: "approved-app",
  });
  const ambiguous = await selectGuidedImprove(async <T>(sql: string) =>
    (sql.startsWith("SELECT data FROM workflows")
      ? [{ data: { id: "one" } }, { data: { id: "two" } }]
      : []) as T[],
  );
  assert.match("error" in ambiguous ? ambiguous.error : "", /More than one/);
});

test("authorizes only the explicitly configured Telegram chat", () => {
  assert.equal(isAuthorizedChat("-10042", -10042), true);
  assert.equal(isAuthorizedChat("-10042", "-10043"), false);
  assert.equal(isAuthorizedChat("42", "042"), false);
});

test("advances the durable Telegram offset and identifies duplicate updates", () => {
  assert.deepEqual(advanceTelegramOffset(0, 12), {
    duplicate: false,
    next: 13,
  });
  assert.deepEqual(advanceTelegramOffset(13, 12), {
    duplicate: true,
    next: 13,
  });
  assert.deepEqual(advanceTelegramOffset(13, 13), {
    duplicate: false,
    next: 14,
  });
});

test("supports bounded intervals and cron expressions", () => {
  const start = new Date("2026-09-06T12:00:00.000Z");
  assert.equal(everyIntervalMs("@every 5m"), 300_000);
  assert.equal(everyIntervalMs("@every 0m"), null);
  assert.equal(
    nextScheduleWake("@every 5m", start).toISOString(),
    "2026-09-06T12:05:00.000Z",
  );
  assert.equal(
    nextScheduleWake("15 * * * *", start).toISOString(),
    "2026-09-06T12:15:00.000Z",
  );
});

test("transport stub: a persisted schedule wake is not duplicated after restart", async () => {
  const dueAt = new Date(Date.now() - 1000).toISOString();
  const state = new Map<string, unknown>([
    ["schedule:builder", { expression: "@every 1h", nextAt: dueAt }],
  ]);
  const agent: Agent = {
    id: "builder",
    name: "Builder",
    role: "Builder",
    systemPrompt: "Build the requested app.",
    model: "test/model",
    tools: [],
    memory: [],
    skills: [],
    approval: "never",
    guardrails: {
      maxCostUsd: 1,
      maxTurns: 1,
      callsPerHour: 10,
      blockedActions: [],
    },
    schedule: {
      enabled: true,
      expression: "@every 1h",
      prompt: "Build the report.",
      workflowId: null,
    },
    telegram: false,
  };
  const enqueued: { idempotencyKey?: string; requestSender?: string }[] = [];
  const query = async <T>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    if (sql.startsWith("SELECT value")) {
      const value = state.get(String(params[0]));
      return (value === undefined ? [] : [{ value }]) as T[];
    }
    if (sql.startsWith("INSERT INTO integration_state")) {
      state.set(String(params[0]), JSON.parse(String(params[1])));
      return [];
    }
    if (sql.startsWith("SELECT key,value"))
      return [...state].map(([key, value]) => ({ key, value })) as T[];
    throw new Error(`Unexpected SQL in transport stub: ${sql}`);
  };
  const enqueue = async (input: {
    prompt: string;
    idempotencyKey?: string;
    requestSender?: string;
  }): Promise<Run> => {
    enqueued.push({
      idempotencyKey: input.idempotencyKey,
      requestSender: input.requestSender,
    });
    return {
      id: "scheduled-run",
      workflowId: null,
      agentId: "builder",
      prompt: input.prompt,
      status: "queued",
      currentNode: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      costUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      error: null,
      revisionId: null,
      parentRunId: null,
      steps: 0,
    };
  };
  const dependencies = {
    query,
    listAgents: async () => [agent],
    enqueue,
    approve: async () => {
      throw new Error("not used");
    },
    getRun: async (): Promise<RunDetail | null> => null,
    log: async () => {},
  };
  const first = startIntegrations(dependencies);
  for (let attempt = 0; attempt < 20 && enqueued.length === 0; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  await first.stop();
  const second = startIntegrations(dependencies);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await second.stop();
  assert.deepEqual(enqueued, [
    {
      idempotencyKey: `schedule:builder:${dueAt}`,
      requestSender: "schedule:builder",
    },
  ]);
  const statuses = await listScheduleStatuses(query, dependencies.listAgents);
  assert.equal(statuses[0].agentId, "builder");
  assert.equal(statuses[0].enabled, true);
  assert.match(statuses[0].nextAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
});
