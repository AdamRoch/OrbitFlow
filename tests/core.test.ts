import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentSchema,
  workflowSchema,
  effectiveTools,
} from "../src/server/config.js";
import { defaultAgent } from "../src/server/seed.js";
import {
  resolveOutcome,
  enqueue,
  approve,
  cancel,
  resume,
  reconcileUsage,
  claimTurnForExecution,
  recordRuntimeFailure,
  getRun,
} from "../src/server/engine.js";
import { migrate, pool, query } from "../src/server/db.js";
import type { Workflow } from "../src/shared/types.js";
import { randomUUID } from "node:crypto";

const testDatabaseUrl = process.env.DATABASE_URL;
let verificationDatabase = false;
try {
  const target = new URL(testDatabaseUrl ?? "");
  verificationDatabase =
    ["postgres:", "postgresql:"].includes(target.protocol) &&
    ["127.0.0.1", "localhost"].includes(target.hostname) &&
    target.port === "54329" &&
    target.username === "orbitflow" &&
    target.pathname === "/orbitflow";
} catch {
  // The explicit error below keeps malformed URLs away from the database client.
}
if (!verificationDatabase)
  throw new Error(
    "Refusing to run core database tests outside the isolated orbitflow verification database; use npm test",
  );

const graph: Workflow = {
  id: "test",
  name: "Feedback",
  description: "",
  entryNode: "a",
  nodes: [
    {
      id: "a",
      agentId: "a",
      label: "A",
      x: 0,
      y: 0,
      terminalOutcomes: [],
    },
    {
      id: "b",
      agentId: "b",
      label: "B",
      x: 100,
      y: 0,
      terminalOutcomes: ["approved"],
    },
  ],
  edges: [
    { id: "one", from: "a", to: "b", outcome: "review" },
    { id: "two", from: "b", to: "a", outcome: "revise" },
  ],
};
test("configured routes preserve review feedback and custom conditions", () => {
  assert.deepEqual(resolveOutcome(graph, "a", "review"), {
    kind: "route",
    to: "b",
  });
  assert.deepEqual(resolveOutcome(graph, "b", "revise"), {
    kind: "route",
    to: "a",
  });
  assert.deepEqual(resolveOutcome(graph, "b", "approved"), {
    kind: "terminal",
  });
  assert.equal(resolveOutcome(graph, "a", "completed").kind, "unmatched");
  assert.deepEqual(
    resolveOutcome(
      {
        ...graph,
        edges: [
          ...graph.edges,
          { id: "default", from: "b", to: "a", outcome: "*" },
        ],
      },
      "b",
      "custom",
    ),
    { kind: "route", to: "a" },
  );
  assert.throws(() =>
    workflowSchema.parse({ ...graph, edges: [...graph.edges, graph.edges[0]] }),
  );
  assert.throws(() =>
    workflowSchema.parse({
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === "b" ? { ...node, terminalOutcomes: ["revise"] } : node,
      ),
    }),
  );
});
test("agent settings validate limits and enforce blocked native tools", () => {
  const a = defaultAgent("a", "A", "Builder", "Prompt");
  assert.deepEqual(agentSchema.parse(a).memory, []);
  assert.throws(() =>
    agentSchema.parse({ ...a, guardrails: { ...a.guardrails, maxTurns: 0 } }),
  );
  assert.deepEqual(
    effectiveTools({
      ...a,
      tools: ["read", "edit"],
      guardrails: { ...a.guardrails, blockedActions: ["edit"] },
    }),
    ["read"],
  );
});
test("real PostgreSQL enqueue deduplicates, snapshots configuration and persists addressed requests", async () => {
  await migrate();
  const id = `check-${randomUUID()}`;
  const a = defaultAgent(
    id,
    "Verification agent",
    "Builder",
    "Original immutable prompt",
  );
  await query("INSERT INTO agents(id,data) VALUES($1,$2)", [id, a]);
  const key = randomUUID();
  const [one, two] = await Promise.all([
    enqueue({
      agentId: id,
      prompt: "Critical-path local database check",
      idempotencyKey: key,
    }),
    enqueue({
      agentId: id,
      prompt: "Critical-path local database check",
      idempotencyKey: key,
    }),
  ]);
  assert.equal(one.id, two.id);
  await query(
    'UPDATE agents SET data=data||\'{"systemPrompt":"Edited later"}\'::jsonb WHERE id=$1',
    [id],
  );
  const [snapshot] = await query<{ snapshot: { agents: (typeof a)[] } }>(
    "SELECT snapshot FROM runs WHERE id=$1",
    [one.id],
  );
  assert.equal(
    snapshot.snapshot.agents[0].systemPrompt,
    "Original immutable prompt",
  );
  const detail = await getRun(one.id);
  assert.equal(detail?.messages.length, 1);
  assert.equal(detail?.messages[0].to, id);
  await assert.rejects(
    () => approve(one.id, true, "", "not-pending"),
    /not awaiting approval/,
  );
  const cancelled = await cancel(one.id);
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(() => cancel(one.id), /terminal/);
  // Retain rows as named local verification evidence; do not erase data.
});
test("failed runs resume at their retained node only after cost is known", async () => {
  const suffix = randomUUID();
  const builder = defaultAgent(
    `resume-builder-${suffix}`,
    "Resume Builder",
    "Builder",
    "Build",
  );
  const reviewer = defaultAgent(
    `resume-reviewer-${suffix}`,
    "Resume Reviewer",
    "Reviewer",
    "Review",
  );
  await query("INSERT INTO agents(id,data) VALUES($1,$2),($3,$4)", [
    builder.id,
    builder,
    reviewer.id,
    reviewer,
  ]);
  const workflow: Workflow = {
    ...graph,
    id: `resume-workflow-${suffix}`,
    nodes: [
      { ...graph.nodes[0], agentId: builder.id },
      { ...graph.nodes[1], agentId: reviewer.id },
    ],
  };
  await query("INSERT INTO workflows(id,data) VALUES($1,$2)", [
    workflow.id,
    workflow,
  ]);
  const failed = await enqueue({
    workflowId: workflow.id,
    prompt: "Resume at review without replaying the completed builder",
  });
  const revision = randomUUID();
  await query("INSERT INTO revisions(id,run_id,files) VALUES($1,$2,$3)", [
    revision,
    failed.id,
    { "index.html": "<p>Retained resume artifact</p>" },
  ]);
  await query(
    `UPDATE runs SET data=data||jsonb_build_object('status','failed','currentNode','b','steps',1,'revisionId',$2::text,'error','Review transport failed') WHERE id=$1`,
    [failed.id, revision],
  );
  const [before] = await query<{ snapshot: unknown }>(
    "SELECT snapshot FROM runs WHERE id=$1",
    [failed.id],
  );
  const resumed = await resume(failed.id);
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.currentNode, "b");
  assert.equal(resumed.steps, 1);
  assert.equal(resumed.revisionId, revision);
  assert.equal(resumed.error, null);
  const detail = await getRun(failed.id);
  assert.equal(detail?.events.at(-1)?.kind, "resumed");
  const [after] = await query<{ snapshot: unknown }>(
    "SELECT snapshot FROM runs WHERE id=$1",
    [failed.id],
  );
  assert.deepEqual(after.snapshot, before.snapshot);
  await cancel(failed.id);

  const knownFailure = await enqueue({
    agentId: builder.id,
    prompt: "Known failed attempt accounting boundary",
  });
  await claimTurnForExecution(knownFailure.id, builder.id);
  await recordRuntimeFailure(knownFailure.id, {
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 20,
  });
  await query(
    `UPDATE runs SET data=data||jsonb_build_object('status','failed','error','Known provider failure') WHERE id=$1`,
    [knownFailure.id],
  );
  const [knownAccounting] = await query<{
    data: { costUsd: number; inputTokens: number; outputTokens: number };
    snapshot: {
      agentCalls: Record<string, number>;
      agentCosts: Record<string, number>;
      pendingUsage?: unknown;
    };
  }>("SELECT data,snapshot FROM runs WHERE id=$1", [knownFailure.id]);
  assert.equal(knownAccounting.data.costUsd, 0.01);
  assert.equal(knownAccounting.data.inputTokens, 100);
  assert.equal(knownAccounting.data.outputTokens, 20);
  assert.equal(knownAccounting.snapshot.agentCalls[builder.id], 1);
  assert.equal(knownAccounting.snapshot.agentCosts[builder.id], 0.01);
  assert.equal(knownAccounting.snapshot.pendingUsage, undefined);
  assert.equal((await resume(knownFailure.id)).status, "queued");
  const [afterKnownResume] = await query<{
    snapshot: { agentCalls: Record<string, number> };
  }>("SELECT snapshot FROM runs WHERE id=$1", [knownFailure.id]);
  assert.equal(afterKnownResume.snapshot.agentCalls[builder.id], 1);
  await cancel(knownFailure.id);

  const unknown = await enqueue({
    agentId: builder.id,
    prompt: "Unknown cost resume boundary",
  });
  await query(
    `UPDATE runs SET data=data||jsonb_build_object('costUsd',0.01),snapshot=jsonb_set(jsonb_set(snapshot,'{agentCalls}',jsonb_build_object($2::text,1)),'{agentCosts}',jsonb_build_object($2::text,0.01)) WHERE id=$1`,
    [unknown.id, builder.id],
  );
  await claimTurnForExecution(unknown.id, builder.id);
  await recordRuntimeFailure(unknown.id, {
    costUsd: null,
    inputTokens: 50,
    outputTokens: 5,
  });
  await query(
    `UPDATE runs SET data=data||jsonb_build_object('status','failed','error','Unknown usage') WHERE id=$1`,
    [unknown.id],
  );
  await assert.rejects(() => resume(unknown.id), /cost is unknown/);
  const reconciled = await reconcileUsage(unknown.id, {
    totalRunCostUsd: 0.025,
    note: "Provider receipt supplied for recovery test; token counts unavailable.",
  });
  assert.equal(reconciled.costUsd, 0.025);
  assert.equal(reconciled.usageIncomplete, true);
  assert.match(reconciled.usageNote ?? "", /Provider receipt/);
  const [reconciledSnapshot] = await query<{
    snapshot: {
      agentCalls: Record<string, number>;
      agentCosts: Record<string, number>;
      pendingUsage?: unknown;
    };
  }>("SELECT snapshot FROM runs WHERE id=$1", [unknown.id]);
  assert.equal(reconciledSnapshot.snapshot.agentCalls[builder.id], 2);
  assert.equal(reconciledSnapshot.snapshot.agentCosts[builder.id], 0.025);
  assert.equal(reconciledSnapshot.snapshot.pendingUsage, undefined);
  assert.equal((await resume(unknown.id)).status, "queued");
  await cancel(unknown.id);

  const historical = await enqueue({
    agentId: builder.id,
    prompt: "Historical unknown usage has no safe agent attribution",
  });
  await query(
    `UPDATE runs SET data=data||jsonb_build_object('status','failed','costUsd',NULL,'error','Legacy unknown usage') WHERE id=$1`,
    [historical.id],
  );
  await reconcileUsage(historical.id, {
    totalRunCostUsd: 0.02,
    note: "Historical provider receipt without durable attempt attribution.",
  });
  await assert.rejects(() => resume(historical.id), /start a new run instead/);

  const activeUsage = await enqueue({
    agentId: builder.id,
    prompt: "Active usage reconciliation boundary",
  });
  await query(
    `UPDATE runs SET data=data||jsonb_build_object('status','running','costUsd',NULL) WHERE id=$1`,
    [activeUsage.id],
  );
  await assert.rejects(
    () =>
      reconcileUsage(activeUsage.id, {
        totalRunCostUsd: 0,
        note: "Must not be accepted while running.",
      }),
    /only after execution has stopped/,
  );
  await query(
    `UPDATE runs SET data=data||jsonb_build_object('status','cancelled','costUsd',0) WHERE id=$1`,
    [activeUsage.id],
  );

  const cancelled = await enqueue({
    agentId: builder.id,
    prompt: "Cancelled resume boundary",
  });
  await cancel(cancelled.id);
  await assert.rejects(() => resume(cancelled.id), /Only a failed run/);
  await assert.rejects(
    () =>
      reconcileUsage(cancelled.id, {
        totalRunCostUsd: 0,
        note: "Known cost must not be replaced.",
      }),
    /already known/,
  );
  // Retain rows as named local verification evidence; do not erase data.
});
test("human approval is bound to pending revision and records feedback atomically", async () => {
  const id = `check-${randomUUID()}`,
    a = defaultAgent(id, "Approval verification", "Builder", "Prompt");
  await query("INSERT INTO agents(id,data) VALUES($1,$2)", [id, a]);
  const r = await enqueue({
    agentId: id,
    prompt: "Approval boundary local database check",
  });
  const revision = randomUUID();
  await query("INSERT INTO revisions(id,run_id,files) VALUES($1,$2,$3)", [
    revision,
    r.id,
    {
      "index.html":
        "<p>Approval test artifact, not a generated application</p>",
    },
  ]);
  const token = randomUUID();
  await query(
    `UPDATE runs SET data=data||jsonb_build_object('status','awaiting_approval','revisionId',$2::text),snapshot=snapshot||jsonb_build_object('approvalKind','release','approvalToken',$3::text) WHERE id=$1`,
    [r.id, revision, token],
  );
  assert.equal((await getRun(r.id))?.approvalToken, token);
  await assert.rejects(
    () => approve(r.id, true, "", "stale-token"),
    /missing or stale/,
  );
  assert.equal((await getRun(r.id))?.run.status, "awaiting_approval");
  await assert.rejects(() => approve(r.id, false, "", token), /feedback/);
  assert.equal((await getRun(r.id))?.run.status, "awaiting_approval");
  assert.equal((await approve(r.id, true, "", token)).status, "completed");
  assert.equal((await getRun(r.id))?.revisions[0].approved, true);
  await assert.rejects(
    () => approve(r.id, true, "", token),
    /not awaiting approval/,
  );
  await pool.end();
});
