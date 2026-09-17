import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  Agent,
  Workflow,
  Run,
  RunDetail,
  Event,
  Revision,
  Message,
} from "../shared/types.js";
import { pool, query } from "./db.js";
import { executeTurn, RuntimeFailure } from "./runtime.js";
import { effectiveTools } from "./config.js";

type Snapshot = {
  agents: Agent[];
  workflow: Workflow | null;
  files: Record<string, string>;
  approvalKind?: "turn" | "release";
  approvalToken?: string;
  permit?: boolean;
  feedback?: string;
  agentCalls: Record<string, number>;
  agentCosts: Record<string, number>;
  pendingUsage?: {
    agentId: string;
    baseRunCostUsd: number;
    baseAgentCostUsd: number;
  };
  unattributedUsage?: boolean;
  channel?: { chatId: string; updateId: number };
};
export type EnqueueInput = {
  workflowId?: string;
  agentId?: string;
  prompt: string;
  parentRunId?: string;
  channel?: { chatId: string; updateId: number };
  idempotencyKey?: string;
  requestSender?: string;
};
export const bus = new EventEmitter();
export const listAgents = async () =>
  (
    await query<{ data: Agent }>(
      "SELECT data FROM agents ORDER BY data->>'name'",
    )
  ).map((r) => r.data);
export async function log(runId: string | null, kind: string, content: string) {
  const [r] = await query<{ id: string; created_at: Date }>(
    "INSERT INTO events(run_id,kind,content) VALUES($1,$2,$3) RETURNING id,created_at",
    [runId, kind, content.slice(0, 12000)],
  );
  bus.emit("update", {
    id: String(r.id),
    runId,
    kind,
    content: content.slice(0, 12000),
    createdAt: r.created_at.toISOString(),
  } satisfies Event);
}
export async function getRun(id: string): Promise<RunDetail | null> {
  const [row] = await query<{ data: Run; snapshot: Snapshot }>(
    "SELECT data,snapshot FROM runs WHERE id=$1",
    [id],
  );
  if (!row) return null;
  const [messages, events, revisions] = await Promise.all([
    query<{ data: Message }>(
      "SELECT data FROM messages WHERE run_id=$1 ORDER BY created_at,id",
      [id],
    ),
    query<{ id: string; kind: string; content: string; created_at: Date }>(
      "SELECT * FROM events WHERE run_id=$1 ORDER BY id",
      [id],
    ),
    query<{
      id: string;
      files: Record<string, string>;
      approved: boolean;
      created_at: Date;
    }>("SELECT * FROM revisions WHERE run_id=$1 ORDER BY created_at", [id]),
  ]);
  return {
    approvalKind: row.snapshot.approvalKind,
    ...(row.data.status === "awaiting_approval" && row.snapshot.approvalToken
      ? { approvalToken: row.snapshot.approvalToken }
      : {}),
    run: row.data,
    messages: messages.map((x) => x.data),
    events: events.map((x) => ({
      id: String(x.id),
      runId: id,
      kind: x.kind,
      content: x.content,
      createdAt: x.created_at.toISOString(),
    })),
    revisions: revisions.map((x) => ({
      id: x.id,
      runId: id,
      createdAt: x.created_at.toISOString(),
      files: Object.keys(x.files),
      approved: x.approved,
    })),
    executionSnapshot: {
      agents: row.snapshot.agents,
      workflow: row.snapshot.workflow,
    },
  };
}
export async function enqueue(input: EnqueueInput): Promise<Run> {
  if (!input.prompt?.trim() || input.prompt.length > 20000)
    throw Error("Provide a request of 1–20,000 characters");
  if (Boolean(input.agentId) === Boolean(input.workflowId))
    throw Error("Choose exactly one workflow or agent");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.idempotencyKey) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [input.idempotencyKey],
      );
      const prior = await client.query(
        "SELECT data FROM runs WHERE idempotency_key=$1",
        [input.idempotencyKey],
      );
      if (prior.rows[0]) {
        await client.query("COMMIT");
        return prior.rows[0].data;
      }
    }
    let workflow: Workflow | null = null;
    if (input.workflowId) {
      const w = await client.query("SELECT data FROM workflows WHERE id=$1", [
        input.workflowId,
      ]);
      if (!w.rows[0]) throw Error("Workflow not found");
      workflow = w.rows[0].data;
    }
    if (workflow?.requiresSource && !input.parentRunId)
      throw Error("This workflow requires an approved application to improve");
    const ids = workflow
      ? [...new Set(workflow.nodes.map((n) => n.agentId))]
      : [input.agentId!];
    const agents = (
      await client.query("SELECT data FROM agents WHERE id=ANY($1::text[])", [
        ids,
      ])
    ).rows.map((x) => x.data) as Agent[];
    if (agents.length !== ids.length)
      throw Error("One or more agents no longer exist");
    let files: Record<string, string> = {};
    if (input.parentRunId) {
      const p = await client.query(
        "SELECT v.files FROM revisions v JOIN runs r ON r.data->>'revisionId'=v.id WHERE r.id=$1 AND v.approved=true",
        [input.parentRunId],
      );
      if (!p.rows[0])
        throw Error("Choose a run with an approved application revision");
      files = p.rows[0].files;
    }
    const id = randomUUID(),
      now = new Date().toISOString();
    const run: Run = {
      id,
      workflowId: workflow?.id ?? null,
      agentId: input.agentId ?? null,
      prompt: input.prompt.trim(),
      status: "queued",
      currentNode: workflow?.entryNode ?? null,
      createdAt: now,
      updatedAt: now,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      error: null,
      revisionId: null,
      parentRunId: input.parentRunId ?? null,
      steps: 0,
    };
    const snapshot: Snapshot = {
      agents,
      workflow,
      files,
      agentCalls: {},
      agentCosts: {},
      channel: input.channel,
    };
    await client.query(
      "INSERT INTO runs(id,data,snapshot,idempotency_key) VALUES($1,$2,$3,$4)",
      [id, run, snapshot, input.idempotencyKey ?? null],
    );
    const entryAgentId =
      workflow?.nodes.find((node) => node.id === workflow!.entryNode)
        ?.agentId ?? input.agentId!;
    const message: Message = {
      id: randomUUID(),
      runId: id,
      from: input.requestSender ?? (input.channel ? "telegram" : "human"),
      to: entryAgentId,
      content: run.prompt,
      kind: "request",
      createdAt: now,
    };
    await client.query(
      "INSERT INTO messages(id,run_id,data) VALUES($1,$2,$3)",
      [message.id, id, message],
    );
    await client.query("COMMIT");
    await log(id, "queued", "Request queued");
    return run;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
const active = new Map<string, AbortController>();
export async function cancel(id: string) {
  const rows = await query<{ data: Run }>(
    `UPDATE runs SET data=data||jsonb_build_object('status','cancelled','updatedAt',now()::text) WHERE id=$1 AND data->>'status' IN ('queued','running','awaiting_approval') RETURNING data`,
    [id],
  );
  if (!rows[0]) throw Error("Run is missing or already terminal");
  active.get(id)?.abort();
  await log(id, "cancelled", "Cancelled by human");
  return rows[0].data;
}
export async function resume(id: string) {
  if (active.has(id)) throw Error("Run is still active and cannot be resumed");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await c.query<{ data: Run; snapshot: Snapshot }>(
      "SELECT data,snapshot FROM runs WHERE id=$1 FOR UPDATE",
      [id],
    );
    const run = result.rows[0]?.data;
    if (!run) throw Error("Run not found");
    if (run.status !== "failed") throw Error("Only a failed run can be resumed");
    if (active.has(id)) throw Error("Run is still active and cannot be resumed");
    if (run.costUsd === null)
      throw Error("Run cost is unknown and must be reconciled before resume");
    if (result.rows[0].snapshot.unattributedUsage)
      throw Error(
        "This historical run has usage that cannot be attributed to an agent; start a new run instead",
      );
    const unknown = await c.query(
      "SELECT id FROM runs WHERE data->>'costUsd' IS NULL LIMIT 1",
    );
    if (unknown.rows.length)
      throw Error(
        "An earlier provider turn has unknown cost; reconcile its usage before resume",
      );
    run.status = "queued";
    run.error = null;
    run.updatedAt = new Date().toISOString();
    await c.query("UPDATE runs SET data=$2 WHERE id=$1", [id, run]);
    const event = await c.query<{ id: string; created_at: Date }>(
      "INSERT INTO events(run_id,kind,content) VALUES($1,'resumed',$2) RETURNING id,created_at",
      [id, `Resumed by human at workflow node ${run.currentNode ?? "single agent"}`],
    );
    await c.query("COMMIT");
    const recorded = event.rows[0];
    bus.emit("update", {
      id: String(recorded.id),
      runId: id,
      kind: "resumed",
      content: `Resumed by human at workflow node ${run.currentNode ?? "single agent"}`,
      createdAt: recorded.created_at.toISOString(),
    } satisfies Event);
    return run;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
export type UsageReconciliation = {
  totalRunCostUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  note: string;
};
export async function reconcileUsage(id: string, input: UsageReconciliation) {
  if (active.has(id))
    throw Error("Run is still active and its usage cannot be reconciled");
  if (!Number.isFinite(input.totalRunCostUsd) || input.totalRunCostUsd < 0)
    throw Error("totalRunCostUsd must be a finite nonnegative number");
  for (const [name, value] of [
    ["inputTokens", input.inputTokens],
    ["outputTokens", input.outputTokens],
  ] as const)
    if (value !== undefined && (!Number.isInteger(value) || value < 0))
      throw Error(`${name} must be a nonnegative integer when provided`);
  const note = input.note.trim();
  if (!note || note.length > 2000)
    throw Error("A provider receipt note of 1–2,000 characters is required");

  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await c.query<{ data: Run; snapshot: Snapshot }>(
      "SELECT data,snapshot FROM runs WHERE id=$1 FOR UPDATE",
      [id],
    );
    const run = result.rows[0]?.data;
    const snapshot = result.rows[0]?.snapshot;
    if (!run) throw Error("Run not found");
    if (!["failed", "completed", "cancelled", "awaiting_approval"].includes(run.status))
      throw Error("Usage can be reconciled only after execution has stopped");
    if (active.has(id))
      throw Error("Run is still active and its usage cannot be reconciled");
    if (run.costUsd !== null) throw Error("Run cost is already known");

    if (snapshot.pendingUsage) {
      const pending = snapshot.pendingUsage;
      if (input.totalRunCostUsd < pending.baseRunCostUsd)
        throw Error(
          `totalRunCostUsd cannot be less than the already known $${pending.baseRunCostUsd.toFixed(6)}`,
        );
      snapshot.agentCosts[pending.agentId] =
        pending.baseAgentCostUsd +
        (input.totalRunCostUsd - pending.baseRunCostUsd);
      snapshot.pendingUsage = undefined;
      snapshot.unattributedUsage = false;
    } else {
      snapshot.unattributedUsage = true;
    }

    run.costUsd = input.totalRunCostUsd;
    if (input.inputTokens !== undefined) run.inputTokens = input.inputTokens;
    if (input.outputTokens !== undefined) run.outputTokens = input.outputTokens;
    run.usageIncomplete =
      input.inputTokens === undefined || input.outputTokens === undefined;
    run.usageNote = note;
    run.updatedAt = new Date().toISOString();
    await c.query("UPDATE runs SET data=$2,snapshot=$3 WHERE id=$1", [
      id,
      run,
      snapshot,
    ]);
    const content = `Usage reconciled by human from a provider receipt: $${input.totalRunCostUsd.toFixed(6)}; ${run.usageIncomplete ? "token counts remain incomplete" : "token counts supplied"}. ${note}`;
    const event = await c.query<{ id: string; created_at: Date }>(
      "INSERT INTO events(run_id,kind,content) VALUES($1,'usage_reconciled',$2) RETURNING id,created_at",
      [id, content],
    );
    await c.query("COMMIT");
    const recorded = event.rows[0];
    bus.emit("update", {
      id: String(recorded.id),
      runId: id,
      kind: "usage_reconciled",
      content,
      createdAt: recorded.created_at.toISOString(),
    } satisfies Event);
    return run;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
export async function approve(
  id: string,
  approved: boolean,
  feedback: string,
  expectedApprovalToken: string,
) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await c.query(
      "SELECT data,snapshot FROM runs WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!r.rows[0] || r.rows[0].data.status !== "awaiting_approval")
      throw Error("Run is not awaiting approval");
    const run = r.rows[0].data as Run,
      s = r.rows[0].snapshot as Snapshot;
    if (!expectedApprovalToken || s.approvalToken !== expectedApprovalToken)
      throw Error(
        "Approval is missing or stale; refresh the run before deciding",
      );
    if (!approved && !feedback.trim())
      throw Error("Provide feedback when requesting a revision");
    if (s.approvalKind === "release" && approved) {
      run.status = "completed";
      if (run.revisionId)
        await c.query("UPDATE revisions SET approved=true WHERE id=$1", [
          run.revisionId,
        ]);
    } else {
      run.status = "queued";
      s.permit = approved;
      if (!approved) {
        s.feedback = feedback.trim();
        run.currentNode = s.workflow?.entryNode ?? null;
        run.revisionId = null;
      }
    }
    s.approvalKind = undefined;
    s.approvalToken = undefined;
    run.updatedAt = new Date().toISOString();
    const targetAgentId =
      s.workflow?.nodes.find((node) => node.id === run.currentNode)?.agentId ??
      run.agentId ??
      "workflow";
    const m: Message = {
      id: randomUUID(),
      runId: id,
      from: "human",
      to: targetAgentId,
      content: approved ? "Approved" : feedback.trim(),
      kind: "approval",
      createdAt: run.updatedAt,
    };
    await c.query("INSERT INTO messages(id,run_id,data) VALUES($1,$2,$3)", [
      m.id,
      id,
      m,
    ]);
    await c.query("UPDATE runs SET data=$2,snapshot=$3 WHERE id=$1", [
      id,
      run,
      s,
    ]);
    await c.query("COMMIT");
    await log(
      id,
      approved ? "approved" : "feedback",
      approved ? "Human approved pending work" : feedback,
    );
    return run;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function spent() {
  const [r] = await query<{ cost: string }>(
    `SELECT COALESCE(sum((data->>'costUsd')::numeric),0)::text cost FROM runs`,
  );
  return Number(r.cost);
}
export type OutcomeResolution =
  | { kind: "route"; to: string }
  | { kind: "terminal" }
  | { kind: "unmatched"; error: string };
export function resolveOutcome(
  workflow: Workflow,
  nodeId: string,
  outcome: string,
): OutcomeResolution {
  const exact = workflow.edges.find(
    (edge) => edge.from === nodeId && edge.outcome === outcome,
  );
  if (exact) return { kind: "route", to: exact.to };
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if ((node?.terminalOutcomes ?? []).includes(outcome))
    return { kind: "terminal" };
  const fallback = workflow.edges.find(
    (edge) => edge.from === nodeId && edge.outcome === "*",
  );
  if (fallback) return { kind: "route", to: fallback.to };
  const allowed = [
    ...workflow.edges
      .filter((edge) => edge.from === nodeId && edge.outcome !== "*")
      .map((edge) => edge.outcome),
    ...(node?.terminalOutcomes ?? []),
  ];
  return {
    kind: "unmatched",
    error: `${node?.label ?? nodeId} returned outcome ${JSON.stringify(outcome)}; allowed outcomes: ${allowed.length ? allowed.map((value) => JSON.stringify(value)).join(", ") : "none"}`,
  };
}
async function step(id: string) {
  const [row] = await query<{ data: Run; snapshot: Snapshot }>(
    "SELECT data,snapshot FROM runs WHERE id=$1",
    [id],
  );
  if (!row || row.data.status !== "queued") return;
  const run = row.data;
  let s = row.snapshot;
  const agentId =
    s.workflow?.nodes.find((n) => n.id === run.currentNode)?.agentId ??
    run.agentId;
  const a = s.agents.find((x) => x.id === agentId);
  if (!a) throw Error("Run snapshot has no executable agent");
  if (a.approval === "always" && !s.permit) {
    s.approvalKind = "turn";
    s.approvalToken = randomUUID();
    run.status = "awaiting_approval";
    await saveQueued(run, s);
    await log(id, "approval_required", `Approve the next turn by ${a.name}`);
    return;
  }
  const budget = Number(process.env.ORBITFLOW_PROVIDER_BUDGET_USD ?? 0);
  if (!(budget > 0))
    throw Error(
      "Real provider calls require an explicitly authorized ORBITFLOW_PROVIDER_BUDGET_USD budget",
    );
  if (
    (await query("SELECT id FROM runs WHERE data->>'costUsd' IS NULL LIMIT 1"))
      .length
  )
    throw Error(
      "An earlier provider turn has unknown cost; reconcile its usage before further paid work",
    );
  const totalSpent = await spent();
  if (totalSpent >= budget)
    throw Error("Authorized provider budget reached");
  if ((s.agentCalls[a.id] ?? 0) >= a.guardrails.maxTurns)
    throw Error(`${a.name} reached its configured turn limit`);
  const agentSpent = s.agentCosts[a.id] ?? 0;
  if (agentSpent >= a.guardrails.maxCostUsd)
    throw Error(`${a.name} reached its configured cost limit`);
  const remainingCostUsd = Math.min(
    budget - totalSpent,
    a.guardrails.maxCostUsd - agentSpent,
  );
  if (!(remainingCostUsd > 0))
    throw Error(`${a.name} has no authorized provider budget remaining`);
  const [rate] = await query<{ n: string }>(
    `SELECT count(*)::text n FROM events WHERE kind='turn_started' AND content=$1 AND created_at>now()-interval '1 hour'`,
    [a.id],
  );
  if (Number(rate.n) >= a.guardrails.callsPerHour)
    throw Error(`${a.name} reached its hourly call limit`);
  const claimedSnapshot = await claimTurnForExecution(id, a.id);
  if (!claimedSnapshot) return;
  s = claimedSnapshot;
  const controller = new AbortController();
  active.set(id, controller);
  await log(id, "turn_started", a.id);
  try {
    const detail = await getRun(id);
    const workflowNode = s.workflow?.nodes.find(
      (node) => node.id === run.currentNode,
    );
    const hasWildcard = s.workflow?.edges.some(
      (edge) => edge.from === run.currentNode && edge.outcome === "*",
    );
    const allowedOutcomes = hasWildcard
      ? []
      : [
          ...(s.workflow?.edges
            .filter(
              (edge) => edge.from === run.currentNode && edge.outcome !== "*",
            )
            .map((edge) => edge.outcome) ?? []),
          ...(workflowNode?.terminalOutcomes ?? []),
        ];
    const prompt = [
      `Original request: ${run.prompt}`,
      s.feedback ? `Human revision request: ${s.feedback}` : "",
      allowedOutcomes.length
        ? `Workflow routing requirement: return outcome exactly as one of ${allowedOutcomes.map((outcome) => JSON.stringify(outcome)).join(", ")}.`
        : "",
      "Durable conversation:",
      ...(detail?.messages ?? [])
        .slice(-20)
        .map((m) => `${m.from} -> ${m.to}: ${m.content}`),
    ]
      .filter(Boolean)
      .join("\n\n");
    const result = await executeTurn({
      id,
      agent: { ...a, tools: effectiveTools(a) },
      prompt,
      files: s.files,
      maxCostUsd: remainingCostUsd,
      allowedOutcomes: hasWildcard ? undefined : allowedOutcomes,
      signal: controller.signal,
      onEvent: async (event: any) => {
        if (typeof event === "string") {
          await log(id, "tool", event);
          return;
        }
        const serialize = (stringLimit: number, arrayLimit: number) =>
          JSON.stringify(event, (_key, value) => {
            if (typeof value === "string" && value.length > stringLimit)
              return `${value.slice(0, stringLimit)}… [truncated]`;
            if (Array.isArray(value) && value.length > arrayLimit)
              return [...value.slice(0, arrayLimit), `[${value.length - arrayLimit} more items]`];
            return value;
          });
        let serialized = serialize(2_000, 40);
        if (serialized.length > 11_000) serialized = serialize(300, 10);
        if (serialized.length > 11_000) {
          const runtimeDetail = event?.detail;
          const part = runtimeDetail?.properties?.part;
          const short = (value: unknown) => {
            const text = typeof value === "string" ? value : JSON.stringify(value);
            return text?.length > 2_000 ? `${text.slice(0, 2_000)}… [truncated]` : text;
          };
          serialized = JSON.stringify({
            kind: event?.kind,
            content: event?.content,
            detail: {
              type: runtimeDetail?.type,
              properties: {
                sessionID: runtimeDetail?.properties?.sessionID,
                part: part
                  ? {
                      id: part.id,
                      callID: part.callID,
                      type: part.type,
                      tool: part.tool,
                      state: part.state
                        ? {
                            status: part.state.status,
                            title: short(part.state.title),
                            input: short(part.state.input),
                            output: short(part.state.output),
                          }
                        : undefined,
                    }
                  : undefined,
              },
            },
            truncated: true,
          });
        }
        await log(id, "tool", serialized);
      },
    });
    s.permit = false;
    s.feedback = undefined;
    if (result.costUsd === null) {
      run.usageIncomplete = true;
      run.usageNote =
        "The latest provider attempt returned unknown cost; recorded token totals may be partial until a provider receipt is reconciled.";
    } else {
      s.agentCosts[a.id] = (s.agentCosts[a.id] ?? 0) + result.costUsd;
      s.pendingUsage = undefined;
    }
    s.files = result.files;
    run.steps++;
    run.inputTokens += result.inputTokens;
    run.outputTokens += result.outputTokens;
    run.costUsd =
      run.costUsd === null || result.costUsd === null
        ? null
        : run.costUsd + result.costUsd;
    const resolution = s.workflow
      ? resolveOutcome(s.workflow, run.currentNode!, result.outcome)
      : ({ kind: "terminal" } satisfies OutcomeResolution);
    const next = resolution.kind === "route" ? resolution.to : null;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const current = await c.query(
        "SELECT data FROM runs WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (current.rows[0].data.status === "cancelled") {
        await c.query("UPDATE runs SET data=data||$2::jsonb,snapshot=$3 WHERE id=$1", [
          id,
          JSON.stringify({
            costUsd: run.costUsd,
            inputTokens: run.inputTokens,
            outputTokens: run.outputTokens,
          }),
          s,
        ]);
        await c.query("COMMIT");
        return;
      }
      const nextAgentId = next
        ? s.workflow?.nodes.find((node) => node.id === next)?.agentId
        : null;
      if (next && !nextAgentId)
        throw Error("Workflow route points to a node with no agent");
      const message: Message = {
        id: randomUUID(),
        runId: id,
        from: a.id,
        to: nextAgentId ?? "human",
        content: result.summary,
        kind: next ? "handoff" : "result",
        createdAt: new Date().toISOString(),
      };
      await c.query("INSERT INTO messages(id,run_id,data) VALUES($1,$2,$3)", [
        message.id,
        id,
        message,
      ]);
      if (Object.keys(result.files).length) {
        const revisionId = randomUUID();
        await c.query(
          "INSERT INTO revisions(id,run_id,files) VALUES($1,$2,$3)",
          [revisionId, id, result.files],
        );
        run.revisionId = revisionId;
      }
      if (next) {
        run.currentNode = next;
        run.status = "queued";
      } else if (resolution.kind === "unmatched") {
        run.status = "failed";
        run.error = resolution.error;
        s.approvalKind = undefined;
        s.approvalToken = undefined;
      } else {
        const needsApproval =
          Boolean(run.revisionId) &&
          s.agents.some(
            (x) => (s.agentCalls[x.id] ?? 0) > 0 && x.approval !== "never",
          );
        run.status = needsApproval ? "awaiting_approval" : "completed";
        s.approvalKind = needsApproval ? "release" : undefined;
        s.approvalToken = needsApproval ? randomUUID() : undefined;
        if (!needsApproval && run.revisionId)
          await c.query("UPDATE revisions SET approved=true WHERE id=$1", [
            run.revisionId,
          ]);
      }
      if (result.costUsd === null && next) {
        run.status = "failed";
        run.error =
          "Runtime cost is unknown; further automatic spending stopped";
      }
      run.updatedAt = new Date().toISOString();
      await c.query("UPDATE runs SET data=$2,snapshot=$3 WHERE id=$1", [
        id,
        run,
        s,
      ]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    await log(
      id,
      "turn_completed",
      `${a.name}: ${result.outcome}. ${result.summary}`,
    );
  } catch (error) {
    if (error instanceof RuntimeFailure) {
      await recordRuntimeFailure(id, error.usage);
    }
    throw error;
  } finally {
    active.delete(id);
  }
}
export async function recordRuntimeFailure(
  id: string,
  usage: { costUsd: number | null; inputTokens: number; outputTokens: number },
) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const current = await c.query<{ data: Run; snapshot: Snapshot }>(
      "SELECT data,snapshot FROM runs WHERE id=$1 FOR UPDATE",
      [id],
    );
    const failedRun = current.rows[0].data;
    const failedSnapshot = current.rows[0].snapshot;
    failedRun.inputTokens += usage.inputTokens;
    failedRun.outputTokens += usage.outputTokens;
    if (usage.costUsd === null) {
      failedRun.costUsd = null;
      failedRun.usageIncomplete = true;
      failedRun.usageNote =
        "The latest provider attempt returned unknown cost; recorded token totals may be partial until a provider receipt is reconciled.";
    } else {
      failedRun.costUsd = (failedRun.costUsd ?? 0) + usage.costUsd;
      const pending = failedSnapshot.pendingUsage;
      if (pending)
        failedSnapshot.agentCosts[pending.agentId] =
          pending.baseAgentCostUsd + usage.costUsd;
      else failedSnapshot.unattributedUsage = true;
      failedSnapshot.pendingUsage = undefined;
    }
    await c.query("UPDATE runs SET data=$2,snapshot=$3 WHERE id=$1", [
      id,
      failedRun,
      failedSnapshot,
    ]);
    await c.query("COMMIT");
  } catch (accountingError) {
    await c.query("ROLLBACK");
    throw accountingError;
  } finally {
    c.release();
  }
}
export async function claimTurnForExecution(
  id: string,
  agentId: string,
): Promise<Snapshot | null> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await c.query<{ data: Run; snapshot: Snapshot }>(
      "SELECT data,snapshot FROM runs WHERE id=$1 FOR UPDATE",
      [id],
    );
    const row = result.rows[0];
    if (!row || row.data.status !== "queued") {
      await c.query("COMMIT");
      return null;
    }
    row.snapshot.agentCalls[agentId] =
      (row.snapshot.agentCalls[agentId] ?? 0) + 1;
    row.snapshot.pendingUsage = {
      agentId,
      baseRunCostUsd: row.data.costUsd ?? 0,
      baseAgentCostUsd: row.snapshot.agentCosts[agentId] ?? 0,
    };
    row.data.status = "running";
    row.data.updatedAt = new Date().toISOString();
    await c.query("UPDATE runs SET data=$2,snapshot=$3 WHERE id=$1", [
      id,
      row.data,
      row.snapshot,
    ]);
    await c.query("COMMIT");
    return row.snapshot;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
async function saveQueued(run: Run, s: Snapshot) {
  run.updatedAt = new Date().toISOString();
  await query(
    "UPDATE runs SET data=$2,snapshot=$3 WHERE id=$1 AND data->>'status'='queued'",
    [run.id, run, s],
  );
}
export async function startEngine() {
  const lock = await pool.connect();
  const acquired = await lock.query(
    "SELECT pg_try_advisory_lock(43104310) locked",
  );
  if (!acquired.rows[0].locked) {
    lock.release();
    throw Error("Another OrbitFlow executor owns this database");
  }
  await query(
    `UPDATE runs SET data=data||jsonb_build_object('status','failed','costUsd',NULL,'usageIncomplete',true,'usageNote','The executor restarted during an external turn; cost and token totals may be partial until a provider receipt is reconciled.','error','Executor restarted during an external turn; inspect retained events before explicitly retrying','updatedAt',now()::text) WHERE data->>'status'='running'`,
  );
  let stopped = false;
  let pending: Promise<void> | null = null;
  const tick = async () => {
    if (stopped || pending) return;
    pending = (async () => {
      const [r] = await query<{ id: string }>(
        `SELECT id FROM runs WHERE data->>'status'='queued' ORDER BY created_at LIMIT 1`,
      );
      if (!r) return;
      try {
        await step(r.id);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Execution failed";
        await query(
          `UPDATE runs SET data=data||jsonb_build_object('status','failed','error',$2::text,'updatedAt',now()::text) WHERE id=$1 AND data->>'status' NOT IN ('cancelled','completed')`,
          [r.id, message],
        );
        await log(r.id, "error", message);
      }
    })();
    try {
      await pending;
    } finally {
      pending = null;
    }
  };
  const timer = setInterval(() => {
    void tick().catch((e) =>
      console.error(
        "Executor database failure",
        e instanceof Error ? e.message : "unknown",
      ),
    );
  }, 500);
  return async () => {
    stopped = true;
    clearInterval(timer);
    for (const c of active.values()) c.abort();
    await pending;
    await lock.query("SELECT pg_advisory_unlock(43104310)");
    lock.release();
  };
}
