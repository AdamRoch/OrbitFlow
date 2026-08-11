import { setTimeout as delay } from "node:timers/promises";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  consumeNextMessage,
  insertMessage,
  runMessageBusWorker,
  type DatabaseId,
  type JsonObject as MessageJsonObject,
  type MessageRow,
} from "./message-bus.ts";
import {
  parseAgentGuardrails,
  parseRunCostLimit,
} from "../guardrails.ts";
import {
  WorkflowGraphError,
  asJsonObject,
  evaluateGraph,
  parseWorkflowGraph,
  workflowEntryNodeId,
  type JsonObject,
  type WorkflowGraph,
  type WorkflowNode,
} from "../workflow/graph.ts";

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export interface WorkflowRunRecord {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  triggerType: "channel" | "ui" | "cron";
  spec: JsonObject;
  startedAt: Date | null;
  endedAt: Date | null;
  totalTokens: string;
  totalCost: string;
  failureReason: string | null;
  graphSnapshot: JsonObject | null;
}

export interface WorkflowThreadState {
  id: string;
  runId: string;
  ticketId: string | null;
  status: "running" | "paused";
  pauseReason: string | null;
}

export interface RuntimeDispatchRequest {
  idempotencyKey: string;
  generation: string;
  runId: string;
  dispatchId: string;
  nodeId: string;
  agentId: string;
  model: string;
  ticketId: string | null;
  ephemeral: boolean;
  input: JsonObject;
}

export type RuntimeStartResult =
  | { kind: "started"; sessionId: string }
  | { kind: "confirmed_failure"; reason: string };

export type RuntimeReconciliationResult =
  | RuntimeStartResult
  | { kind: "absent" }
  | { kind: "pending"; reason: string };

/** FACT-11 supplies the real implementation. FACT-10 depends only on this seam. */
export interface RuntimeAdapter {
  startSession(request: RuntimeDispatchRequest): Promise<RuntimeStartResult>;
  reconcileSession(request: RuntimeDispatchRequest): Promise<RuntimeReconciliationResult>;
}

export interface WorkflowEngineWorker {
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

export interface WorkflowEngineOptions {
  consumerId: string;
  dispatcherId: string;
  pollIntervalMs?: number;
  retryIntervalMs?: number;
  dispatchLeaseMs?: number;
}

export class WorkflowStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowStateError";
  }
}

const DISPATCH_CANDIDATE_LIMIT = 32;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_DISPATCH_LEASE_MS = 300_000;
const MIN_INTERVAL_MS = 10;
const MAX_INTERVAL_MS = 3_600_000;

function positiveId(value: DatabaseId, field: string): string {
  if (typeof value === "bigint" && value > BigInt(0)) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  throw new TypeError(`${field} must be a positive integer`);
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-blank string`);
  }
  return value.trim();
}

function interval(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (
    !Number.isInteger(resolved) ||
    resolved < MIN_INTERVAL_MS ||
    resolved > MAX_INTERVAL_MS
  ) {
    throw new RangeError(
      `${field} must be an integer from ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS}`,
    );
  }
  return resolved;
}

function runFromRow(row: QueryResultRow): WorkflowRunRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status,
    triggerType: row.trigger_type,
    spec: row.spec,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    totalTokens: row.total_tokens,
    totalCost: row.total_cost,
    failureReason: row.failure_reason,
    graphSnapshot: row.graph_snapshot,
  };
}

async function inTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createWorkflowRun(
  pool: Pool,
  input: {
    workflowId: DatabaseId;
    triggerType: "channel" | "ui" | "cron";
    spec: JsonObject;
  },
): Promise<WorkflowRunRecord> {
  const workflowId = positiveId(input.workflowId, "workflowId");
  if (!(["channel", "ui", "cron"] as unknown[]).includes(input.triggerType)) {
    throw new TypeError("triggerType must be channel, ui, or cron");
  }
  const spec = asJsonObject(input.spec, "spec");
  const result = await pool.query(
    `INSERT INTO workflow_runs (workflow_id, trigger_type, spec)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [workflowId, input.triggerType, spec],
  );
  return runFromRow(result.rows[0]);
}

export async function getWorkflowRun(
  pool: Pool,
  runId: DatabaseId,
): Promise<WorkflowRunRecord | null> {
  const result = await pool.query("SELECT * FROM workflow_runs WHERE id = $1", [
    positiveId(runId, "runId"),
  ]);
  return result.rows[0] ? runFromRow(result.rows[0]) : null;
}

function dispatchKey(
  runId: string,
  sourceMessageId: string | null,
  nodeId: string,
  ticketId: string | null,
): string {
  return [
    "workflow",
    runId,
    "message",
    sourceMessageId ?? "start",
    "node",
    nodeId,
    "ticket",
    ticketId ?? "run",
  ].join(":");
}

async function ticketInput(
  transaction: PoolClient,
  ticketId: string | null,
): Promise<JsonObject | null> {
  if (!ticketId) return null;
  const result = await transaction.query(
    `SELECT id, identifier, title, description, acceptance_criteria, status, priority
     FROM tickets
     WHERE id = $1`,
    [ticketId],
  );
  if (!result.rows[0]) throw new WorkflowStateError(`ticket ${ticketId} disappeared`);
  const ticket = result.rows[0];
  return {
    id: ticket.id,
    identifier: ticket.identifier,
    title: ticket.title,
    description: ticket.description,
    acceptanceCriteria: ticket.acceptance_criteria,
    status: ticket.status,
    priority: ticket.priority,
  } as JsonObject;
}

async function insertDispatch(
  transaction: PoolClient,
  input: {
    runId: string;
    spec: JsonObject;
    node: WorkflowNode;
    agentModel: string;
    sourceMessageId: string | null;
    sourceHandoffBrief: string | null;
    sourceOutput: JsonObject | null;
    ticketId: string | null;
    fanoutGroupId: string | null;
  },
): Promise<number> {
  const ticket = await ticketInput(transaction, input.ticketId);
  await transaction.query(
    `INSERT INTO workflow_thread_states (run_id, ticket_id)
     VALUES ($1, $2)
     ON CONFLICT ON CONSTRAINT workflow_thread_states_identity_unique DO NOTHING`,
    [input.runId, input.ticketId],
  );
  const dispatchInput: JsonObject = {
    runSpec: input.spec,
    nodeConfig: input.node.config,
    upstream: input.sourceMessageId
      ? {
          messageId: input.sourceMessageId,
          output: input.sourceOutput!,
          handoffBrief: input.sourceHandoffBrief,
        }
      : null,
    ticket,
  };
  const result = await transaction.query(
    `INSERT INTO workflow_dispatches (
       run_id, node_id, agent_id, agent_model, ticket_id, source_message_id,
       fanout_group_id, input, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT ON CONSTRAINT workflow_dispatches_activation_unique DO NOTHING
     RETURNING id`,
    [
      input.runId,
      input.node.id,
      input.node.agentId,
      input.agentModel,
      input.ticketId,
      input.sourceMessageId,
      input.fanoutGroupId,
      dispatchInput,
      dispatchKey(input.runId, input.sourceMessageId, input.node.id, input.ticketId),
    ],
  );
  const inserted = result.rowCount ?? 0;
  if (inserted === 1 && input.ticketId !== null) {
    await transaction.query(
      `UPDATE tickets
       SET assignee_agent_id = $3, updated_at = now()
       WHERE id = $1 AND run_id = $2
         AND assignee_agent_id IS DISTINCT FROM $3`,
      [input.ticketId, input.runId, input.node.agentId],
    );
  }
  return inserted;
}

async function materializeFanoutCapacity(
  transaction: PoolClient,
  runId: string,
  nodeId: string,
): Promise<number> {
  const groups = await transaction.query(
    `SELECT fanout.*, run.spec,
            message.payload -> 'output' AS source_output,
            message.handoff_brief AS source_handoff_brief
     FROM workflow_fanout_groups AS fanout
     JOIN workflow_runs AS run ON run.id = fanout.run_id
     LEFT JOIN messages AS message ON message.id = fanout.source_message_id
     WHERE fanout.run_id = $1 AND fanout.node_id = $2
     ORDER BY fanout.id
     FOR UPDATE OF fanout`,
    [runId, nodeId],
  );
  if (groups.rowCount === 0) return 0;

  const maxConcurrency = Math.min(
    ...groups.rows.map((group) => Number(group.max_concurrency)),
  );
  const materialized = await transaction.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM workflow_dispatches
     WHERE run_id = $1 AND node_id = $2
       AND status IN ('pending', 'dispatching', 'reconciling', 'active')`,
    [runId, nodeId],
  );
  const available = maxConcurrency - materialized.rows[0].count;
  if (available <= 0) return 0;

  const members = await transaction.query(
    `SELECT member.fanout_group_id, member.ticket_id, fanout.node_id,
            fanout.agent_id, fanout.agent_model, fanout.node_config,
            fanout.source_message_id, run.spec,
            message.payload -> 'output' AS source_output,
            message.handoff_brief AS source_handoff_brief
     FROM workflow_fanout_members AS member
     JOIN workflow_fanout_groups AS fanout ON fanout.id = member.fanout_group_id
     JOIN workflow_runs AS run ON run.id = fanout.run_id
     LEFT JOIN messages AS message ON message.id = fanout.source_message_id
     LEFT JOIN workflow_dispatches AS dispatch
       ON dispatch.fanout_group_id = member.fanout_group_id
      AND dispatch.ticket_id = member.ticket_id
     LEFT JOIN workflow_thread_states AS thread
       ON thread.run_id = fanout.run_id AND thread.ticket_id = member.ticket_id
     WHERE fanout.run_id = $1 AND fanout.node_id = $2
       AND dispatch.id IS NULL
       AND COALESCE(thread.status::text, 'running') = 'running'
     ORDER BY fanout.id, member.position
     LIMIT $3
     FOR UPDATE OF member`,
    [runId, nodeId, available],
  );

  let inserted = 0;
  for (const member of members.rows) {
    inserted += await insertDispatch(transaction, {
      runId,
      spec: asJsonObject(member.spec, "workflow run spec"),
      node: {
        id: member.node_id,
        agentId: member.agent_id,
        config: member.node_config as WorkflowNode["config"],
      },
      agentModel: member.agent_model,
      sourceMessageId: member.source_message_id,
      sourceHandoffBrief: member.source_handoff_brief,
      sourceOutput:
        member.source_message_id === null
          ? null
          : asJsonObject(member.source_output, "fan-out source output"),
      ticketId: member.ticket_id,
      fanoutGroupId: member.fanout_group_id,
    });
  }
  return inserted;
}

async function enqueueNode(
  transaction: PoolClient,
  input: {
    runId: string;
    spec: JsonObject;
    node: WorkflowNode;
    sourceMessage: MessageRow | null;
    sourceOutput: JsonObject | null;
    inheritedTicketId: string | null;
  },
): Promise<number> {
  const agent = await transaction.query<{ model: string }>(
    "SELECT model FROM agents WHERE id = $1 FOR KEY SHARE",
    [input.node.agentId],
  );
  if (!agent.rows[0]) {
    throw new WorkflowGraphError(`node ${input.node.id} references a missing agent`);
  }
  const agentModel = agent.rows[0].model;
  const maxConcurrency = input.node.config.fanOut?.maxConcurrency;
  if (!maxConcurrency) {
    return insertDispatch(transaction, {
      ...input,
      agentModel,
      sourceMessageId: input.sourceMessage?.id ?? null,
      sourceHandoffBrief: input.sourceMessage?.handoffBrief ?? null,
      ticketId: input.inheritedTicketId,
      fanoutGroupId: null,
    });
  }

  const group = await transaction.query<{ id: string }>(
    `INSERT INTO workflow_fanout_groups (
       run_id, source_message_id, node_id, agent_id, agent_model,
       node_config, max_concurrency
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT ON CONSTRAINT workflow_fanout_groups_activation_unique
     DO UPDATE SET updated_at = workflow_fanout_groups.updated_at
     RETURNING id`,
    [
      input.runId,
      input.sourceMessage?.id ?? null,
      input.node.id,
      input.node.agentId,
      agentModel,
      input.node.config,
      maxConcurrency,
    ],
  );
  await transaction.query(
    `INSERT INTO workflow_fanout_members (fanout_group_id, position, ticket_id)
     SELECT $2, row_number() OVER (ORDER BY priority DESC, created_at, id)::integer - 1, id
     FROM tickets
     WHERE run_id = $1 AND status IN ('todo', 'in_progress')
     ON CONFLICT ON CONSTRAINT workflow_fanout_members_ticket_unique DO NOTHING`,
    [input.runId, group.rows[0].id],
  );
  return materializeFanoutCapacity(transaction, input.runId, input.node.id);
}

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 500) || "workflow engine failure";
}

async function failRun(
  transaction: PoolClient,
  runId: string,
  code: string,
  reason: string,
): Promise<void> {
  const bounded = boundedReason(reason);
  await transaction.query(
    `UPDATE workflow_dispatches
     SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
         output_message_id = NULL, reconciliation_reason = NULL,
         failure_reason = $2, updated_at = clock_timestamp()
     WHERE run_id = $1 AND status IN ('pending', 'dispatching', 'reconciling', 'active')`,
    [runId, bounded],
  );
  const changed = await transaction.query(
    `UPDATE workflow_runs
     SET status = 'failed', failure_reason = $2,
         ended_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE id = $1 AND status IN ('pending', 'running', 'paused')
     RETURNING id`,
    [runId, bounded],
  );
  if (changed.rowCount === 1) {
    await insertMessage(transaction, {
      runId,
      sender: "system:workflow-engine",
      recipient: "system:operators",
      type: "system",
      payload: { code, message: bounded },
    });
  }
}

export async function startWorkflowRun(
  pool: Pool,
  runIdValue: DatabaseId,
): Promise<WorkflowRunRecord> {
  const runId = positiveId(runIdValue, "runId");
  return inTransaction(pool, async (transaction) => {
    const result = await transaction.query(
      `SELECT run.*, workflow.graph
       FROM workflow_runs AS run
       JOIN workflows AS workflow ON workflow.id = run.workflow_id
       WHERE run.id = $1
       FOR UPDATE OF run, workflow`,
      [runId],
    );
    if (!result.rows[0]) throw new WorkflowStateError(`workflow run ${runId} not found`);
    const row = result.rows[0];
    if (row.status !== "pending") return runFromRow(row);

    try {
      const graph = parseWorkflowGraph(row.graph);
      await transaction.query(
        "UPDATE workflow_runs SET graph_snapshot = $2 WHERE id = $1",
        [runId, row.graph],
      );
      const agentIds = [...new Set(graph.nodes.map((node) => node.agentId))];
      const lockedAgents = await transaction.query(
        "SELECT id FROM agents WHERE id = ANY($1::bigint[]) FOR KEY SHARE",
        [agentIds],
      );
      if (lockedAgents.rowCount !== agentIds.length) {
        throw new WorkflowGraphError("workflow graph references an agent that does not exist");
      }
      await transaction.query(
        `UPDATE workflow_runs
         SET status = 'running', started_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [runId],
      );
      const entryNode = graph.nodes.find((node) => node.id === workflowEntryNodeId(graph))!;
      const inserted = await enqueueNode(transaction, {
        runId,
        spec: row.spec,
        node: entryNode,
        sourceMessage: null,
        sourceOutput: null,
        inheritedTicketId: null,
      });
      if (inserted === 0) {
        await transaction.query(
          `UPDATE workflow_runs
           SET status = 'completed', ended_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE id = $1`,
          [runId],
        );
      }
    } catch (error) {
      if (!(error instanceof WorkflowGraphError)) throw error;
      await failRun(transaction, runId, "workflow_graph_invalid", boundedReason(error));
    }

    const updated = await transaction.query("SELECT * FROM workflow_runs WHERE id = $1", [
      runId,
    ]);
    return runFromRow(updated.rows[0]);
  });
}

async function transitionRun(
  pool: Pool,
  runIdValue: DatabaseId,
  from: WorkflowRunStatus,
  to: WorkflowRunStatus,
): Promise<WorkflowRunRecord> {
  const runId = positiveId(runIdValue, "runId");
  const result = await pool.query(
    `UPDATE workflow_runs
     SET status = $3, updated_at = clock_timestamp()
     WHERE id = $1 AND status = $2
     RETURNING *`,
    [runId, from, to],
  );
  if (result.rows[0]) return runFromRow(result.rows[0]);
  const existing = await getWorkflowRun(pool, runId);
  if (!existing) throw new WorkflowStateError(`workflow run ${runId} not found`);
  if (existing.status === to) return existing;
  throw new WorkflowStateError(
    `workflow run ${runId} cannot transition from ${existing.status} to ${to}`,
  );
}

export async function pauseWorkflowRun(pool: Pool, runId: DatabaseId) {
  return transitionRun(pool, runId, "running", "paused");
}

export async function resumeWorkflowRun(pool: Pool, runId: DatabaseId) {
  return transitionRun(pool, runId, "paused", "running");
}

function threadFromRow(row: QueryResultRow): WorkflowThreadState {
  return {
    id: row.id,
    runId: row.run_id,
    ticketId: row.ticket_id,
    status: row.status,
    pauseReason: row.pause_reason,
  };
}

async function setWorkflowThreadState(
  pool: Pool,
  runIdValue: DatabaseId,
  ticketIdValue: DatabaseId | null,
  status: "running" | "paused",
  pauseReason: string | null,
): Promise<WorkflowThreadState> {
  const runId = positiveId(runIdValue, "runId");
  const ticketId = ticketIdValue === null ? null : positiveId(ticketIdValue, "ticketId");
  return inTransaction(pool, async (transaction) => {
    const run = await transaction.query<{ status: WorkflowRunStatus }>(
      "SELECT status FROM workflow_runs WHERE id = $1 FOR UPDATE",
      [runId],
    );
    if (!run.rows[0]) throw new WorkflowStateError(`workflow run ${runId} not found`);
    if (!["running", "paused"].includes(run.rows[0].status)) {
      throw new WorkflowStateError(
        `workflow run ${runId} cannot change a thread while ${run.rows[0].status}`,
      );
    }
    if (ticketId) {
      const ticket = await transaction.query(
        "SELECT id FROM tickets WHERE id = $1 AND run_id = $2 FOR KEY SHARE",
        [ticketId, runId],
      );
      if (!ticket.rows[0]) {
        throw new WorkflowStateError(`ticket ${ticketId} does not belong to run ${runId}`);
      }
    }
    const changed = await transaction.query(
      `INSERT INTO workflow_thread_states (run_id, ticket_id, status, pause_reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ON CONSTRAINT workflow_thread_states_identity_unique
       DO UPDATE SET status = EXCLUDED.status,
                     pause_reason = EXCLUDED.pause_reason,
                     updated_at = clock_timestamp()
       RETURNING *`,
      [runId, ticketId, status, pauseReason],
    );
    if (ticketId) {
      if (status === "paused") {
        await transaction.query(
          `DELETE FROM workflow_dispatches
           WHERE run_id = $1 AND ticket_id = $2
             AND fanout_group_id IS NOT NULL AND status = 'pending'`,
          [runId, ticketId],
        );
      }
      const nodes = await transaction.query<{ node_id: string }>(
        `SELECT DISTINCT fanout.node_id
         FROM workflow_fanout_members AS member
         JOIN workflow_fanout_groups AS fanout ON fanout.id = member.fanout_group_id
         WHERE fanout.run_id = $1 AND member.ticket_id = $2
         ORDER BY fanout.node_id`,
        [runId, ticketId],
      );
      for (const node of nodes.rows) {
        await materializeFanoutCapacity(transaction, runId, node.node_id);
      }
    }
    return threadFromRow(changed.rows[0]);
  });
}

export async function pauseWorkflowThread(
  pool: Pool,
  runId: DatabaseId,
  ticketId: DatabaseId | null,
  reason: string,
) {
  return setWorkflowThreadState(pool, runId, ticketId, "paused", nonBlank(reason, "reason"));
}

export async function resumeWorkflowThread(
  pool: Pool,
  runId: DatabaseId,
  ticketId: DatabaseId | null,
) {
  return setWorkflowThreadState(pool, runId, ticketId, "running", null);
}

export async function listWorkflowThreadStates(
  pool: Pool,
  runIdValue: DatabaseId,
): Promise<WorkflowThreadState[]> {
  const result = await pool.query(
    `SELECT * FROM workflow_thread_states
     WHERE run_id = $1
     ORDER BY ticket_id NULLS FIRST, id`,
    [positiveId(runIdValue, "runId")],
  );
  return result.rows.map(threadFromRow);
}

interface ClaimedDispatch {
  id: string;
  runId: string;
  nodeId: string;
  agentId: string;
  agentModel: string;
  ticketId: string | null;
  input: JsonObject;
  idempotencyKey: string;
  leaseOwner: string;
  leaseGeneration: string;
  runtimeGeneration: string;
  phase: "start" | "reconcile";
}

interface CostCeilingRefusal {
  scope: "run" | "agent";
  reason: "ceiling_reached" | "unknown_cost";
  ceiling: number;
  spend: string;
}

const RATE_LIMIT_WINDOW = "60 seconds";

/**
 * FACT-23: the engine enforces per-run and per-agent cost ceilings before every
 * wake. When a ceiling is configured and any relevant cost_events row has
 * computed_cost IS NULL the engine cannot prove spend is below the ceiling,
 * so it fails closed by pausing the run with an unknown-cost message until
 * the unknown events are reconciled. Otherwise, spend already at or beyond a
 * ceiling refuses the wake and pauses the run with one durable system message
 * per pause transition. Numeric ceilings compare in PostgreSQL so the exact
 * boundary holds.
 */
async function costCeilingRefusal(
  transaction: PoolClient,
  run: { id: string; spec: unknown; total_cost: string },
  agentId: string,
  agentCostLimit: number | null,
): Promise<CostCeilingRefusal | null> {
  const runCeiling = parseRunCostLimit(run.spec);
  if (runCeiling !== null) {
    const unknownRun = await transaction.query<{ has: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM cost_events WHERE run_id = $1 AND computed_cost IS NULL) AS has",
      [run.id],
    );
    if (unknownRun.rows[0].has) {
      return { scope: "run", reason: "unknown_cost", ceiling: runCeiling, spend: "unknown" };
    }
    const breached = await transaction.query<{ breached: boolean }>(
      "SELECT $1::numeric >= $2::numeric AS breached",
      [run.total_cost, runCeiling],
    );
    if (breached.rows[0].breached) {
      return { scope: "run", reason: "ceiling_reached", ceiling: runCeiling, spend: run.total_cost };
    }
  }
  if (agentCostLimit !== null) {
    const unknownAgent = await transaction.query<{ has: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM cost_events WHERE run_id = $1 AND agent_id = $2 AND computed_cost IS NULL) AS has",
      [run.id, agentId],
    );
    if (unknownAgent.rows[0].has) {
      return { scope: "agent", reason: "unknown_cost", ceiling: agentCostLimit, spend: "unknown" };
    }
    const spend = await transaction.query<{ spend: string; breached: boolean }>(
      `SELECT COALESCE(SUM(computed_cost), 0)::text AS spend,
              COALESCE(SUM(computed_cost), 0) >= $3::numeric AS breached
       FROM cost_events
       WHERE run_id = $1 AND agent_id = $2`,
      [run.id, agentId, agentCostLimit],
    );
    if (spend.rows[0].breached) {
      return { scope: "agent", reason: "ceiling_reached", ceiling: agentCostLimit, spend: spend.rows[0].spend };
    }
  }
  return null;
}

async function pauseRunForCostCeiling(
  transaction: PoolClient,
  dispatch: { id: string; run_id: string; node_id: string; agent_id: string },
  refusal: CostCeilingRefusal,
): Promise<void> {
  const paused = await transaction.query(
    `UPDATE workflow_runs
     SET status = 'paused', updated_at = clock_timestamp()
     WHERE id = $1 AND status = 'running'
     RETURNING id`,
    [dispatch.run_id],
  );
  if (paused.rowCount !== 1) return;
  if (refusal.reason === "unknown_cost") {
    const description =
      refusal.scope === "run"
        ? `the run has cost_events with unknown cost (computed_cost IS NULL) and a run ceiling of ${refusal.ceiling} is active`
        : `agent ${dispatch.agent_id} has cost_events with unknown cost (computed_cost IS NULL) and an agent ceiling of ${refusal.ceiling} is active`;
    await insertMessage(transaction, {
      runId: dispatch.run_id,
      sender: "system:workflow-engine",
      recipient: "system:operators",
      type: "system",
      payload: {
        code: "guardrail_unknown_cost",
        message: `Wake refused for dispatch ${dispatch.id} on node ${dispatch.node_id}: ${description}. Run paused; reconcile unknown cost events and resume to continue.`,
        scope: refusal.scope,
        agentId: dispatch.agent_id,
        runId: dispatch.run_id,
        dispatchId: dispatch.id,
        nodeId: dispatch.node_id,
        ceiling: refusal.ceiling,
      },
    });
    return;
  }
  const detail =
    refusal.scope === "run"
      ? `run spend ${refusal.spend} reached the run cost ceiling ${refusal.ceiling}`
      : `agent ${dispatch.agent_id} spend ${refusal.spend} reached its cost ceiling ${refusal.ceiling}`;
  await insertMessage(transaction, {
    runId: dispatch.run_id,
    sender: "system:workflow-engine",
    recipient: "system:operators",
    type: "system",
    payload: {
      code: "guardrail_cost_ceiling",
      message: `Wake refused for dispatch ${dispatch.id} on node ${dispatch.node_id}: ${detail}. Run paused; raise the ceiling and resume to continue.`,
      scope: refusal.scope,
      agentId: dispatch.agent_id,
      runId: dispatch.run_id,
      dispatchId: dispatch.id,
      nodeId: dispatch.node_id,
      ceiling: refusal.ceiling,
      spend: refusal.spend,
    },
  });
}

async function claimDispatch(
  pool: Pool,
  workerId: string,
  leaseMs: number,
): Promise<ClaimedDispatch | null> {
  return inTransaction(pool, async (transaction) => {
    const candidates = await transaction.query<{
      id: string;
      run_id: string;
      thread_id: string;
    }>(
      `SELECT dispatch.id, dispatch.run_id, thread.id AS thread_id
       FROM workflow_dispatches AS dispatch
       JOIN workflow_runs AS run ON run.id = dispatch.run_id
       JOIN workflow_thread_states AS thread
         ON thread.run_id = dispatch.run_id
        AND thread.ticket_id IS NOT DISTINCT FROM dispatch.ticket_id
       WHERE run.status = 'running'
         AND thread.status = 'running'
         AND (
           dispatch.status = 'pending'
           OR (
             dispatch.status = 'dispatching'
             AND dispatch.lease_expires_at <= clock_timestamp()
           )
           OR (
             dispatch.status = 'reconciling'
             AND (
               dispatch.lease_owner IS NULL
               OR dispatch.lease_expires_at <= clock_timestamp()
             )
           )
       )
       ORDER BY dispatch.created_at, dispatch.id
       LIMIT $1`,
      [DISPATCH_CANDIDATE_LIMIT],
    );

    for (const candidate of candidates.rows) {
      const lockedRun = await transaction.query<{
        id: string;
        status: WorkflowRunStatus;
        spec: unknown;
        total_cost: string;
      }>(
        "SELECT id, status, spec, total_cost FROM workflow_runs WHERE id = $1 FOR UPDATE",
        [candidate.run_id],
      );
      if (lockedRun.rows[0]?.status !== "running") continue;
      const lockedThread = await transaction.query<{ status: "running" | "paused" }>(
        "SELECT status FROM workflow_thread_states WHERE id = $1 FOR UPDATE",
        [candidate.thread_id],
      );
      if (lockedThread.rows[0]?.status !== "running") continue;
      const locked = await transaction.query(
        `SELECT dispatch.*
         FROM workflow_dispatches AS dispatch
         JOIN workflow_runs AS run ON run.id = dispatch.run_id
         JOIN workflow_thread_states AS thread
           ON thread.run_id = dispatch.run_id
          AND thread.ticket_id IS NOT DISTINCT FROM dispatch.ticket_id
         WHERE dispatch.id = $1
           AND run.status = 'running'
           AND thread.status = 'running'
           AND (
             dispatch.status = 'pending'
             OR (
               dispatch.status = 'dispatching'
               AND dispatch.lease_expires_at <= clock_timestamp()
             )
             OR (
               dispatch.status = 'reconciling'
               AND (
                 dispatch.lease_owner IS NULL
                 OR dispatch.lease_expires_at <= clock_timestamp()
               )
             )
           )
         FOR UPDATE OF dispatch SKIP LOCKED`,
        [candidate.id],
      );
      if (!locked.rows[0]) continue;
      const dispatch = locked.rows[0];
      const phase = dispatch.status === "pending" ? "start" : "reconcile";

      if (phase === "start") {
        // Locking the agent row serializes start-phase claims for this agent
        // across runs, so the rate window and agent ceiling cannot be
        // overshot by concurrent dispatch workers.
        const agent = await transaction.query<{ guardrails: unknown }>(
          "SELECT guardrails FROM agents WHERE id = $1 FOR UPDATE",
          [dispatch.agent_id],
        );
        const guardrails = parseAgentGuardrails(agent.rows[0]?.guardrails);
        const refusal = await costCeilingRefusal(
          transaction,
          lockedRun.rows[0],
          dispatch.agent_id,
          guardrails.costLimit,
        );
        if (refusal) {
          await pauseRunForCostCeiling(transaction, dispatch, refusal);
          return null;
        }
        if (guardrails.rateLimitPerMinute !== null) {
          const recent = await transaction.query<{ count: number }>(
            `SELECT count(*)::int AS count
             FROM agent_wake_events
             WHERE agent_id = $1
               AND created_at > clock_timestamp() - $2::interval`,
            [dispatch.agent_id, RATE_LIMIT_WINDOW],
          );
          if (recent.rows[0].count >= guardrails.rateLimitPerMinute) continue;
        }
      }

      const claimed = await transaction.query(
        `UPDATE workflow_dispatches
         SET status = $4::workflow_dispatch_status, lease_owner = $2,
             lease_expires_at = clock_timestamp() + ($3::integer * interval '1 millisecond'),
             attempt_count = attempt_count + 1,
             lease_generation = lease_generation + 1,
             runtime_generation = CASE
               WHEN $4 = 'dispatching' THEN lease_generation + 1
               ELSE runtime_generation
             END,
             reconciliation_reason = CASE
               WHEN $4 = 'reconciling' THEN COALESCE(
                 reconciliation_reason,
                 'provider outcome unknown after dispatch lease expired'
               )
               ELSE NULL
             END,
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING *`,
        [dispatch.id, workerId, leaseMs, phase === "start" ? "dispatching" : "reconciling"],
      );
      const row = claimed.rows[0];
      if (phase === "start") {
        await transaction.query(
          `INSERT INTO agent_wake_events (run_id, agent_id, dispatch_id, lease_generation)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT ON CONSTRAINT agent_wake_events_start_unique DO NOTHING`,
          [row.run_id, row.agent_id, row.id, row.lease_generation],
        );
      }
      return {
        id: row.id,
        runId: row.run_id,
        nodeId: row.node_id,
        agentId: row.agent_id,
        agentModel: row.agent_model,
        ticketId: row.ticket_id,
        input: row.input,
        idempotencyKey: row.idempotency_key,
        leaseOwner: row.lease_owner,
        leaseGeneration: row.lease_generation,
        runtimeGeneration: row.runtime_generation,
        phase,
      };
    }
    return null;
  });
}

export async function dispatchNextWorkflowNode(
  pool: Pool,
  runtime: RuntimeAdapter,
  options: { workerId: string; leaseMs?: number },
): Promise<RuntimeDispatchRequest | null> {
  const workerId = nonBlank(options.workerId, "workerId");
  const leaseMs = interval(options.leaseMs, DEFAULT_DISPATCH_LEASE_MS, "leaseMs");
  const claimed = await claimDispatch(pool, workerId, leaseMs);
  if (!claimed) return null;
  const request: RuntimeDispatchRequest = {
    idempotencyKey: claimed.idempotencyKey,
    generation: claimed.runtimeGeneration,
    runId: claimed.runId,
    dispatchId: claimed.id,
    nodeId: claimed.nodeId,
    agentId: claimed.agentId,
    model: claimed.agentModel,
    ticketId: claimed.ticketId,
    ephemeral: claimed.ticketId !== null,
    input: claimed.input,
  };

  const persistUncertainty = async (reason: unknown) => {
    await pool.query(
      `UPDATE workflow_dispatches
       SET status = 'reconciling', lease_owner = NULL, lease_expires_at = NULL,
           reconciliation_reason = $4, updated_at = clock_timestamp()
       WHERE id = $1 AND status IN ('dispatching', 'reconciling')
         AND lease_owner = $2 AND lease_generation = $3`,
      [claimed.id, claimed.leaseOwner, claimed.leaseGeneration, boundedReason(reason)],
    );
  };
  const persistStarted = async (sessionIdValue: unknown) => {
    const sessionId = nonBlank(sessionIdValue, "runtime sessionId");
    await pool.query(
      `UPDATE workflow_dispatches
       SET status = 'active', runtime_session_id = $4,
           lease_owner = NULL, lease_expires_at = NULL,
           reconciliation_reason = NULL, updated_at = clock_timestamp()
       WHERE id = $1 AND status IN ('dispatching', 'reconciling')
         AND lease_owner = $2 AND lease_generation = $3`,
      [claimed.id, claimed.leaseOwner, claimed.leaseGeneration, sessionId],
    );
  };
  const persistConfirmedFailure = async (reasonValue: unknown) => {
    const reason = boundedReason(nonBlank(reasonValue, "runtime failure reason"));
    await inTransaction(pool, async (transaction) => {
      await transaction.query("SELECT id FROM workflow_runs WHERE id = $1 FOR UPDATE", [
        claimed.runId,
      ]);
      const failed = await transaction.query(
        `UPDATE workflow_dispatches
         SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
             reconciliation_reason = NULL, failure_reason = $4,
             updated_at = clock_timestamp()
         WHERE id = $1 AND status IN ('dispatching', 'reconciling')
           AND lease_owner = $2 AND lease_generation = $3
         RETURNING run_id`,
        [claimed.id, claimed.leaseOwner, claimed.leaseGeneration, reason],
      );
      if (failed.rows[0]) {
        await failRun(transaction, failed.rows[0].run_id, "runtime_dispatch_failed", reason);
      }
    });
  };

  if (claimed.phase === "start") {
    try {
      const result = await runtime.startSession(request);
      if (result?.kind === "started") {
        await persistStarted(result.sessionId);
      } else if (result?.kind === "confirmed_failure") {
        await persistConfirmedFailure(result.reason);
      } else {
        throw new TypeError("runtime start returned an invalid result");
      }
    } catch (error) {
      await persistUncertainty(error);
    }
    return request;
  }

  try {
    const result = await runtime.reconcileSession(request);
    if (result?.kind === "started") {
      await persistStarted(result.sessionId);
    } else if (result?.kind === "absent") {
      await pool.query(
        `UPDATE workflow_dispatches
         SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
             runtime_generation = NULL, reconciliation_reason = NULL,
             updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'reconciling'
           AND lease_owner = $2 AND lease_generation = $3`,
        [claimed.id, claimed.leaseOwner, claimed.leaseGeneration],
      );
    } else if (result?.kind === "pending") {
      await persistUncertainty(nonBlank(result.reason, "runtime reconciliation reason"));
    } else if (result?.kind === "confirmed_failure") {
      await persistConfirmedFailure(result.reason);
    } else {
      throw new TypeError("runtime reconciliation returned an invalid result");
    }
  } catch (error) {
    await persistUncertainty(error);
  }
  return request;
}

function parseOutputMessage(message: MessageRow): {
  dispatchId: string;
  dispatchGeneration: string;
  sessionId: string;
  output: JsonObject;
} {
  const payload = asJsonObject(message.payload, "output message payload");
  const dispatchId = positiveId(payload.dispatchId as DatabaseId, "payload.dispatchId");
  const dispatchGeneration = positiveId(
    payload.dispatchGeneration as DatabaseId,
    "payload.dispatchGeneration",
  );
  const sessionId = nonBlank(payload.sessionId, "payload.sessionId");
  const output = asJsonObject(payload.output, "payload.output");
  if (typeof message.handoffBrief !== "string" || message.handoffBrief.trim() === "") {
    throw new WorkflowGraphError("output message handoffBrief must be non-blank");
  }
  return { dispatchId, dispatchGeneration, sessionId, output };
}

function parseUsage(value: MessageJsonObject | null): {
  input: number;
  output: number;
  cost: number;
} | null {
  if (value === null) return null;
  const input = value.input;
  const output = value.output;
  const cost = value.cost ?? 0;
  if (
    !Number.isSafeInteger(input) ||
    Number(input) < 0 ||
    !Number.isSafeInteger(output) ||
    Number(output) < 0 ||
    typeof cost !== "number" ||
    !Number.isFinite(cost) ||
    cost < 0
  ) {
    throw new WorkflowGraphError(
      "tokenUsage must contain non-negative integer input/output and finite cost",
    );
  }
  if (
    value.total !== undefined &&
    (!Number.isSafeInteger(value.total) || value.total !== Number(input) + Number(output))
  ) {
    throw new WorkflowGraphError("tokenUsage.total must equal input plus output");
  }
  return { input: Number(input), output: Number(output), cost };
}

async function finishRunIfIdle(transaction: PoolClient, runId: string): Promise<void> {
  const outstanding = await transaction.query<{ count: string }>(
    `SELECT (
       SELECT count(*)
       FROM workflow_dispatches
       WHERE run_id = $1 AND status IN ('pending', 'dispatching', 'reconciling', 'active')
     ) + (
       SELECT count(*)
       FROM workflow_fanout_members AS member
       JOIN workflow_fanout_groups AS fanout ON fanout.id = member.fanout_group_id
       WHERE fanout.run_id = $1
         AND NOT EXISTS (
           SELECT 1
           FROM workflow_dispatches AS dispatch
           WHERE dispatch.fanout_group_id = member.fanout_group_id
             AND dispatch.ticket_id = member.ticket_id
             AND dispatch.status = 'completed'
         )
     ) AS count`,
    [runId],
  );
  if (outstanding.rows[0].count === "0") {
    await transaction.query(
      `UPDATE workflow_runs
       SET status = 'completed', ended_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE id = $1 AND status IN ('running', 'paused')`,
      [runId],
    );
  }
}

/**
 * FACT-9 calls this inside its routing transaction. Every graph mutation,
 * dispatch row, cost event, receipt, and cursor advance therefore commits or
 * rolls back as one PostgreSQL unit.
 */
export async function routeWorkflowMessage(
  transaction: PoolClient,
  message: MessageRow,
): Promise<void> {
  if (message.type !== "output") return;
  const runResult = await transaction.query(
    `SELECT run.*
     FROM workflow_runs AS run
     WHERE run.id = $1
     FOR UPDATE OF run`,
    [message.runId],
  );
  if (!runResult.rows[0]) throw new WorkflowStateError(`run ${message.runId} disappeared`);
  const run = runResult.rows[0];
  if (["completed", "failed", "canceled"].includes(run.status)) return;

  let parsed: {
    dispatchId: string;
    dispatchGeneration: string;
    sessionId: string;
    output: JsonObject;
  };
  try {
    parsed = parseOutputMessage(message);
  } catch (error) {
    await failRun(
      transaction,
      message.runId,
      "workflow_output_invalid",
      boundedReason(error),
    );
    return;
  }

  const dispatchResult = await transaction.query(
    `SELECT dispatch.*
     FROM workflow_dispatches AS dispatch
     WHERE dispatch.id = $1 AND dispatch.run_id = $2
     FOR UPDATE OF dispatch`,
    [parsed.dispatchId, message.runId],
  );
  const dispatch = dispatchResult.rows[0];
  if (!dispatch) {
    await failRun(
      transaction,
      message.runId,
      "workflow_output_invalid",
      `output references unknown dispatch ${parsed.dispatchId}`,
    );
    return;
  }
  if (message.ticketId !== dispatch.ticket_id) {
    await failRun(
      transaction,
      message.runId,
      "workflow_output_invalid",
      `output ticket ${message.ticketId ?? "none"} does not match dispatch ticket ${dispatch.ticket_id ?? "none"}`,
    );
    return;
  }
  if (parsed.dispatchGeneration !== dispatch.runtime_generation) {
    // Reconciliation proved the old attempt absent and a newer provider start
    // now owns this dispatch. A late output from the old attempt is harmless.
    return;
  }
  if (dispatch.status === "completed") {
    if (dispatch.runtime_session_id === parsed.sessionId) return;
    await failRun(
      transaction,
      message.runId,
      "workflow_output_invalid",
      `dispatch ${parsed.dispatchId} output names a different runtime session`,
    );
    return;
  }
  if (!(["dispatching", "reconciling", "active"] as string[]).includes(dispatch.status)) {
    await failRun(
      transaction,
      message.runId,
      "workflow_output_invalid",
      `dispatch ${parsed.dispatchId} is ${dispatch.status}, not in flight`,
    );
    return;
  }
  if (
    dispatch.status === "active" &&
    dispatch.runtime_session_id !== parsed.sessionId
  ) {
    await failRun(
      transaction,
      message.runId,
      "workflow_output_invalid",
      `dispatch ${parsed.dispatchId} output names a different runtime session`,
    );
    return;
  }

  try {
    const graph: WorkflowGraph = parseWorkflowGraph(run.graph_snapshot);
    const usage = parseUsage(message.tokenUsage);
    const evaluation = evaluateGraph(graph, dispatch.node_id, parsed.output);

    if (usage) {
      await transaction.query(
        `INSERT INTO cost_events (
           run_id, agent_id, model, tokens_in, tokens_out, computed_cost
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          message.runId,
          dispatch.agent_id,
          dispatch.agent_model,
          usage.input,
          usage.output,
          usage.cost,
        ],
      );
      await transaction.query(
        `UPDATE workflow_runs
         SET total_tokens = total_tokens + $2,
             total_cost = total_cost + $3,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [message.runId, usage.input + usage.output, usage.cost],
      );
    }

    await transaction.query(
      `UPDATE workflow_dispatches
       SET status = 'completed', runtime_session_id = $2,
           lease_owner = NULL, lease_expires_at = NULL,
           output_message_id = $3,
           reconciliation_reason = NULL,
           updated_at = clock_timestamp()
       WHERE id = $1 AND runtime_generation = $4
         AND status IN ('dispatching', 'reconciling', 'active')`,
      [dispatch.id, parsed.sessionId, message.id, parsed.dispatchGeneration],
    );
    await materializeFanoutCapacity(transaction, message.runId, dispatch.node_id);
    if (evaluation.kind === "dispatch") {
      await enqueueNode(transaction, {
        runId: message.runId,
        spec: run.spec,
        node: evaluation.node,
        sourceMessage: message,
        sourceOutput: parsed.output,
        inheritedTicketId: dispatch.ticket_id,
      });
    }
    await finishRunIfIdle(transaction, message.runId);
  } catch (error) {
    if (!(error instanceof WorkflowGraphError)) throw error;
    await failRun(
      transaction,
      message.runId,
      "workflow_evaluation_failed",
      boundedReason(error),
    );
  }
}

export async function consumeNextWorkflowMessage(
  pool: Pool,
  options: { consumerId: string; signal?: AbortSignal },
) {
  return consumeNextMessage(pool, routeWorkflowMessage, options);
}

export async function runWorkflowDispatchWorker(
  pool: Pool,
  runtime: RuntimeAdapter,
  options: {
    workerId: string;
    signal?: AbortSignal;
    pollIntervalMs?: number;
    leaseMs?: number;
  },
): Promise<void> {
  const pollIntervalMs = interval(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    "pollIntervalMs",
  );
  while (!options.signal?.aborted) {
    const dispatched = await dispatchNextWorkflowNode(pool, runtime, options);
    if (dispatched) continue;
    try {
      await delay(pollIntervalMs, undefined, { signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) return;
      throw error;
    }
  }
}

export function startWorkflowEngine(
  pool: Pool,
  runtime: RuntimeAdapter,
  options: WorkflowEngineOptions,
): WorkflowEngineWorker {
  const controller = new AbortController();
  const messageWorker = runMessageBusWorker(pool, routeWorkflowMessage, {
    consumerId: nonBlank(options.consumerId, "consumerId"),
    signal: controller.signal,
    pollIntervalMs: options.pollIntervalMs,
    retryIntervalMs: options.retryIntervalMs,
  });
  const dispatchWorker = runWorkflowDispatchWorker(pool, runtime, {
    workerId: nonBlank(options.dispatcherId, "dispatcherId"),
    signal: controller.signal,
    pollIntervalMs: options.pollIntervalMs,
    leaseMs: options.dispatchLeaseMs,
  });
  const done = Promise.all([messageWorker, dispatchWorker]).then(() => undefined);
  void done.catch(() => controller.abort());
  return {
    done,
    async stop() {
      controller.abort();
      await done;
    },
  };
}
