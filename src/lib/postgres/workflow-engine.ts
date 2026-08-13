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
import { telegramInboundForEngine } from "../telegram/adapter.ts";
import { cronTickForEngine, startScheduleWorker, type ScheduleWorker } from "./scheduling.ts";
import { parseChannelIntakeDecision } from "../channel-intake.ts";
import {
  channelStatusRequestForEngine,
  enqueueChannelCompletionEvent,
  routeChannelCompletionEvent,
  routeChannelStatusRequest,
} from "../channel-reporting.ts";

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
  readonly ready: Promise<void>;
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

function questionRoute(node: WorkflowNode): { target: "agent" | "human-via-channel" | "human-via-UI"; agentId: string | null } {
  const escalation = node.config.questionEscalation;
  const target = escalation?.target ?? "human-via-UI";
  return {
    target,
    agentId: target === "agent" ? positiveId(escalation!.agentId! as DatabaseId, "question escalation agentId") : null,
  };
}

async function pauseThreadInTransaction(
  transaction: PoolClient,
  runId: string,
  ticketId: string | null,
  reason: string,
): Promise<void> {
  await transaction.query(
    `INSERT INTO workflow_thread_states (run_id, ticket_id, status, pause_reason)
     VALUES ($1, $2, 'paused', $3)
     ON CONFLICT ON CONSTRAINT workflow_thread_states_identity_unique
     DO UPDATE SET status = 'paused', pause_reason = EXCLUDED.pause_reason,
                   updated_at = clock_timestamp()`,
    [runId, ticketId, reason],
  );
}

async function openWorkflowQuestion(
  transaction: PoolClient,
  input: {
    runId: string;
    ticketId: string | null;
    dispatchId: string;
    node: WorkflowNode;
    kind: "question" | "approval";
    boundary: "worker" | "before" | "after";
    text: string;
    sender: string;
    questionMessage?: MessageRow;
  },
): Promise<string> {
  const route = questionRoute(input.node);
  if (route.target === "agent") {
    const graph = await transaction.query<{ graph_snapshot: unknown }>(
      "SELECT graph_snapshot FROM workflow_runs WHERE id = $1 FOR KEY SHARE",
      [input.runId],
    );
    const answeringNode = parseWorkflowGraph(graph.rows[0]!.graph_snapshot).nodes.find(
      (node) => String(node.agentId) === route.agentId && node.config.may_answer_questions === true,
    );
    if (!answeringNode) {
      throw new WorkflowGraphError(`question escalation agent ${route.agentId} may not answer questions`);
    }
  }
  const questionMessage = input.questionMessage ?? await insertMessage(transaction, {
    runId: input.runId,
    ticketId: input.ticketId,
    sender: input.sender,
    recipient: route.target === "agent" ? `agent:${route.agentId}` : route.target,
    type: "question",
    payload: { question: input.text, kind: input.kind, boundary: input.boundary },
    handoffBrief: input.text,
  });
  const existing = await transaction.query<{ id: string }>(
    "SELECT id FROM workflow_questions WHERE question_message_id = $1",
    [questionMessage.id],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await transaction.query<{ id: string }>(
    `INSERT INTO workflow_questions (
       run_id, ticket_id, originating_dispatch_id, question_message_id,
       kind, boundary, route, target_agent_id, question_text
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [input.runId, input.ticketId, input.dispatchId, questionMessage.id, input.kind,
      input.boundary, route.target, route.agentId, input.text],
  );
  const questionId = created.rows[0]!.id;
  await pauseThreadInTransaction(transaction, input.runId, input.ticketId, `waiting on question ${questionId}`);

  if (route.target === "human-via-channel") {
    const run = await transaction.query<{ chat_id: string | null }>(
      "SELECT spec #>> '{channelContext,chat,id}' AS chat_id FROM workflow_runs WHERE id = $1",
      [input.runId],
    );
    const chatId = run.rows[0]?.chat_id;
    if (!chatId) throw new WorkflowGraphError("human-via-channel question has no originating channel chat");
    const outbound = await insertMessage(transaction, {
      runId: input.runId,
      ticketId: input.ticketId,
      sender: "system:workflow-engine",
      recipient: `telegram:chat:${chatId}`,
      type: "channel_outbound",
      payload: { provider: "telegram", chatId, text: input.text, questionId },
      handoffBrief: input.text,
    });
    await transaction.query("UPDATE workflow_questions SET outbound_message_id = $2 WHERE id = $1", [questionId, outbound.id]);
  } else if (route.target === "agent") {
    const graph = await transaction.query<{ graph_snapshot: unknown; spec: JsonObject }>(
      "SELECT graph_snapshot, spec FROM workflow_runs WHERE id = $1",
      [input.runId],
    );
    const answeringNode = parseWorkflowGraph(graph.rows[0]!.graph_snapshot).nodes.find(
      (node) => String(node.agentId) === route.agentId && node.config.may_answer_questions === true,
    )!;
    const agent = await transaction.query<{ model: string }>("SELECT model FROM agents WHERE id = $1", [route.agentId]);
    await transaction.query(
      `INSERT INTO workflow_dispatches (
         run_id, node_id, agent_id, agent_model, ticket_id, source_message_id,
         input, idempotency_key, answering_question_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (answering_question_id) DO NOTHING`,
      [input.runId, answeringNode.id, route.agentId, agent.rows[0]!.model, input.ticketId,
        questionMessage.id, { runSpec: graph.rows[0]!.spec, nodeConfig: answeringNode.config,
          questionContext: { questionId, question: input.text, originatingDispatchId: input.dispatchId } },
        `workflow:${input.runId}:question:${questionId}:answer`, questionId],
    );
  }
  return questionId;
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
    skipBeforeApproval?: boolean;
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
  if (inserted === 1 && input.node.config.approvalGates?.pauseBefore === true && !input.skipBeforeApproval) {
    await openWorkflowQuestion(transaction, {
      runId: input.runId, ticketId: input.ticketId, dispatchId: result.rows[0].id,
      node: input.node, kind: "approval", boundary: "before",
      text: `Approve starting workflow node ${input.node.id}?`, sender: "system:workflow-engine",
    });
  }
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
     FROM workflow_dispatches AS dispatch
     JOIN workflow_thread_states AS thread
       ON thread.run_id = dispatch.run_id
      AND thread.ticket_id IS NOT DISTINCT FROM dispatch.ticket_id
     WHERE dispatch.run_id = $1 AND dispatch.node_id = $2
       AND dispatch.status IN ('pending', 'dispatching', 'reconciling', 'active')
       AND (thread.status = 'running' OR dispatch.answering_question_id IS NOT NULL)`,
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
    skipBeforeApproval?: boolean;
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
      skipBeforeApproval: input.skipBeforeApproval,
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

async function startWorkflowRunInTransaction(
  transaction: PoolClient,
  runId: string,
): Promise<WorkflowRunRecord> {
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
}

export async function startWorkflowRun(
  pool: Pool,
  runIdValue: DatabaseId,
): Promise<WorkflowRunRecord> {
  const runId = positiveId(runIdValue, "runId");
  return inTransaction(pool, (transaction) => startWorkflowRunInTransaction(transaction, runId));
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
      answering_question_id: string | null;
    }>(
      `SELECT dispatch.id, dispatch.run_id, thread.id AS thread_id, dispatch.answering_question_id
       FROM workflow_dispatches AS dispatch
       JOIN workflow_runs AS run ON run.id = dispatch.run_id
       JOIN workflow_thread_states AS thread
         ON thread.run_id = dispatch.run_id
        AND thread.ticket_id IS NOT DISTINCT FROM dispatch.ticket_id
       WHERE run.status = 'running'
         AND (thread.status = 'running' OR dispatch.answering_question_id IS NOT NULL)
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
      if (lockedThread.rows[0]?.status !== "running" && candidate.answering_question_id === null) continue;
      const locked = await transaction.query(
        `SELECT dispatch.*
         FROM workflow_dispatches AS dispatch
         JOIN workflow_runs AS run ON run.id = dispatch.run_id
         JOIN workflow_thread_states AS thread
           ON thread.run_id = dispatch.run_id
          AND thread.ticket_id IS NOT DISTINCT FROM dispatch.ticket_id
         WHERE dispatch.id = $1
           AND run.status = 'running'
           AND (thread.status = 'running' OR dispatch.answering_question_id IS NOT NULL)
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
    const completed = await transaction.query(
      `UPDATE workflow_runs
       SET status = 'completed', ended_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE id = $1 AND status IN ('running', 'paused')`,
      [runId],
    );
    if (completed.rowCount === 1) await enqueueChannelCompletionEvent(transaction, runId);
  }
}

async function handleChannelIntakeOutput(
  transaction: PoolClient,
  run: QueryResultRow,
  dispatch: QueryResultRow,
  output: JsonObject,
): Promise<
  | { kind: "not_intake" }
  | { kind: "waiting" }
  | { kind: "already_ready" }
  | { kind: "ready"; spec: JsonObject }
> {
  if (run.trigger_type !== "channel") return { kind: "not_intake" };
  const graph = parseWorkflowGraph(run.graph_snapshot);
  if (dispatch.node_id !== workflowEntryNodeId(graph)) return { kind: "not_intake" };

  const intakeResult = await transaction.query(
    "SELECT * FROM channel_intakes WHERE run_id = $1 FOR UPDATE",
    [run.id],
  );
  const intake = intakeResult.rows[0];
  if (!intake) return { kind: "not_intake" };
  if (intake.status === "ready") return { kind: "already_ready" };
  if (intake.status !== "collecting") {
    throw new WorkflowGraphError(`channel intake is ${intake.status}`);
  }

  const decision = parseChannelIntakeDecision(output);
  const existingSpec = asJsonObject(run.spec, "workflow run spec");
  const channelContext = asJsonObject(
    existingSpec.channelContext,
    "workflow run spec.channelContext",
  );
  if (channelContext.provider !== "telegram") {
    throw new WorkflowGraphError("channel intake provider must be telegram");
  }
  const chat = asJsonObject(channelContext.chat, "workflow run spec.channelContext.chat");
  const chatId = nonBlank(chat.id, "workflow run spec.channelContext.chat.id");

  if (decision.kind === "needs_clarification") {
    await insertMessage(transaction, {
      runId: run.id,
      sender: `agent:${dispatch.agent_id}`,
      recipient: `telegram:chat:${chatId}`,
      type: "channel_outbound",
      payload: {
        provider: "telegram",
        chatId,
        text: decision.question,
      },
      handoffBrief: decision.question,
    });
    await transaction.query(
      `UPDATE channel_intakes
       SET last_question = $2, clarification_count = clarification_count + 1,
           updated_at = clock_timestamp()
       WHERE run_id = $1 AND status = 'collecting'`,
      [run.id, decision.question],
    );
    await transaction.query(
      `UPDATE workflow_runs
       SET spec = jsonb_set(spec, '{intake}', $2::jsonb),
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [run.id, JSON.stringify({ status: "collecting", lastQuestion: decision.question })],
    );
    return { kind: "waiting" };
  }

  const spec: JsonObject = {
    schemaVersion: 1,
    objective: decision.spec.objective,
    acceptanceCriteria: decision.spec.acceptanceCriteria,
    constraints: decision.spec.constraints,
    channelContext,
  };
  const changed = await transaction.query(
    `UPDATE channel_intakes
     SET status = 'ready', last_question = NULL, validated_spec = $2,
         updated_at = clock_timestamp()
     WHERE run_id = $1 AND status = 'collecting'
     RETURNING run_id`,
    [run.id, spec],
  );
  if (changed.rowCount !== 1) return { kind: "already_ready" };
  await transaction.query(
    `UPDATE workflow_runs
     SET spec = $2, updated_at = clock_timestamp()
     WHERE id = $1`,
    [run.id, spec],
  );
  return { kind: "ready", spec };
}

async function resumeThreadInTransaction(
  transaction: PoolClient,
  runId: string,
  ticketId: string | null,
): Promise<void> {
  await transaction.query(
    `UPDATE workflow_thread_states
     SET status = 'running', pause_reason = NULL, updated_at = clock_timestamp()
     WHERE run_id = $1 AND ticket_id IS NOT DISTINCT FROM $2`,
    [runId, ticketId],
  );
}

async function routeQuestionMessage(transaction: PoolClient, message: MessageRow): Promise<void> {
  const known = await transaction.query("SELECT id FROM workflow_questions WHERE question_message_id = $1", [message.id]);
  if (known.rows[0]) return;
  const match = /^agent:([1-9]\d*)$/.exec(message.sender);
  if (!match) throw new WorkflowGraphError("question sender must be an agent");
  const text = typeof message.payload.question === "string" && message.payload.question.trim()
    ? message.payload.question.trim()
    : message.handoffBrief?.trim();
  if (!text) throw new WorkflowGraphError("question must contain non-blank payload.question or handoffBrief");
  const namedDispatchId = message.payload.dispatchId === undefined
    ? null
    : positiveId(message.payload.dispatchId as DatabaseId, "question payload.dispatchId");
  const dispatchResult = await transaction.query(
    `SELECT dispatch.*, run.graph_snapshot
     FROM workflow_dispatches AS dispatch
     JOIN workflow_runs AS run ON run.id = dispatch.run_id
     WHERE dispatch.run_id = $1 AND dispatch.ticket_id IS NOT DISTINCT FROM $2
       AND dispatch.agent_id = $3
       AND ($4::bigint IS NULL OR dispatch.id = $4)
       AND dispatch.status IN ('dispatching', 'reconciling', 'active', 'completed')
       AND dispatch.answering_question_id IS NULL
     ORDER BY dispatch.id DESC LIMIT 1
     FOR UPDATE OF dispatch, run`,
    [message.runId, message.ticketId, match[1], namedDispatchId],
  );
  const dispatch = dispatchResult.rows[0];
  if (!dispatch) throw new WorkflowGraphError("question does not match an in-flight worker dispatch");
  if (message.payload.dispatchGeneration !== undefined) {
    const generation = positiveId(
      message.payload.dispatchGeneration as DatabaseId,
      "question payload.dispatchGeneration",
    );
    if (generation !== dispatch.runtime_generation) {
      throw new WorkflowGraphError("question names a different dispatch generation");
    }
  }
  if (message.payload.sessionId !== undefined && dispatch.runtime_session_id !== null) {
    const sessionId = nonBlank(message.payload.sessionId, "question payload.sessionId");
    if (sessionId !== dispatch.runtime_session_id) {
      throw new WorkflowGraphError("question names a different runtime session");
    }
  }
  const prior = await transaction.query(
    `SELECT id FROM workflow_questions
     WHERE originating_dispatch_id = $1 AND boundary = 'worker'`,
    [dispatch.id],
  );
  if (prior.rows[0]) return;
  if (dispatch.status === "completed") {
    throw new WorkflowGraphError("question does not match an in-flight worker dispatch");
  }
  const graph = parseWorkflowGraph(dispatch.graph_snapshot);
  const node = graph.nodes.find((candidate) => candidate.id === dispatch.node_id)!;
  const questionId = await openWorkflowQuestion(transaction, {
    runId: message.runId, ticketId: message.ticketId, dispatchId: dispatch.id,
    node, kind: "question", boundary: "worker", text, sender: message.sender,
    questionMessage: message,
  });
  await transaction.query(
    `UPDATE workflow_dispatches
     SET status = 'completed', output_message_id = $2,
         lease_owner = NULL, lease_expires_at = NULL,
         reconciliation_reason = NULL, updated_at = clock_timestamp()
     WHERE id = $1 AND status IN ('dispatching', 'reconciling', 'active')`,
    [dispatch.id, message.id],
  );
  await materializeFanoutCapacity(transaction, message.runId, dispatch.node_id);
  await transaction.query(
    "UPDATE workflow_questions SET updated_at = clock_timestamp() WHERE id = $1",
    [questionId],
  );
}

function approvingAnswer(message: MessageRow): boolean {
  if (message.payload.approved === true) return true;
  const answer = typeof message.payload.answer === "string" ? message.payload.answer.trim().toLowerCase() : "";
  return ["approve", "approved", "yes", "y"].includes(answer);
}

async function routeAnswerMessage(transaction: PoolClient, message: MessageRow): Promise<void> {
  const questionId = positiveId(message.payload.questionId as DatabaseId, "answer payload.questionId");
  const result = await transaction.query(
    `SELECT question.*, dispatch.node_id, dispatch.agent_id AS originating_agent_id,
            dispatch.agent_model, dispatch.output_message_id, run.graph_snapshot, run.spec
     FROM workflow_questions AS question
     JOIN workflow_dispatches AS dispatch ON dispatch.id = question.originating_dispatch_id
     JOIN workflow_runs AS run ON run.id = question.run_id
     WHERE question.id = $1 AND question.run_id = $2
     FOR UPDATE OF question, dispatch, run`,
    [questionId, message.runId],
  );
  const question = result.rows[0];
  if (!question) throw new WorkflowGraphError(`answer references unknown question ${questionId}`);
  if (message.ticketId !== question.ticket_id) throw new WorkflowGraphError("answer ticket does not match question ticket");
  if (question.status === "answered") return;
  if (question.route === "agent" && message.sender !== `agent:${question.target_agent_id}`) {
    throw new WorkflowGraphError("answer sender is not the configured escalation agent");
  }
  if (question.route === "human-via-channel" && !message.sender.startsWith("telegram:chat:")) {
    throw new WorkflowGraphError("channel answer sender is not Telegram");
  }
  if (question.route === "human-via-UI" && message.sender !== "human:ui") {
    throw new WorkflowGraphError("UI answer sender is invalid");
  }
  if (question.kind === "approval" && !approvingAnswer(message)) return;

  await transaction.query(
    `UPDATE workflow_questions
     SET status = 'answered', answer_message_id = $2, answered_at = clock_timestamp(),
         updated_at = clock_timestamp()
     WHERE id = $1 AND status = 'pending'`,
    [questionId, message.id],
  );
  if (question.route === "agent" && message.payload.answeringDispatchId !== undefined) {
    const answeringDispatchId = positiveId(message.payload.answeringDispatchId as DatabaseId, "answeringDispatchId");
    const generation = positiveId(message.payload.dispatchGeneration as DatabaseId, "answer dispatchGeneration");
    const sessionId = nonBlank(message.payload.sessionId, "answer sessionId");
    const completedAnswer = await transaction.query(
      `UPDATE workflow_dispatches
       SET status = 'completed', output_message_id = $2, runtime_session_id = $5,
           lease_owner = NULL, lease_expires_at = NULL,
           reconciliation_reason = NULL, updated_at = clock_timestamp()
       WHERE id = $1 AND answering_question_id = $3
         AND runtime_generation = $4
         AND status IN ('dispatching', 'reconciling', 'active')`,
      [answeringDispatchId, message.id, questionId, generation, sessionId],
    );
    if (completedAnswer.rowCount !== 1) throw new WorkflowGraphError("answer does not match the active answering dispatch");
  }
  await resumeThreadInTransaction(transaction, message.runId, question.ticket_id);
  const graph = parseWorkflowGraph(question.graph_snapshot);
  const originNode = graph.nodes.find((node) => node.id === question.node_id)!;
  if (question.boundary === "worker") {
    await insertDispatch(transaction, {
      runId: message.runId,
      spec: asJsonObject(question.spec, "workflow run spec"),
      node: originNode,
      agentModel: question.agent_model,
      sourceMessageId: message.id,
      sourceHandoffBrief: message.handoffBrief,
      sourceOutput: { answer: message.payload.answer as string, questionId },
      ticketId: question.ticket_id,
      fanoutGroupId: null,
      skipBeforeApproval: true,
    });
  } else if (question.boundary === "after") {
    const outputMessage = await transaction.query("SELECT * FROM messages WHERE id = $1", [question.output_message_id]);
    const source = outputMessage.rows[0];
    const sourceMessage: MessageRow = {
      id: source.id, runId: source.run_id, ticketId: source.ticket_id,
      sequenceNumber: source.sequence_number, sender: source.sender, recipient: source.recipient,
      type: source.type, payload: source.payload, handoffBrief: source.handoff_brief,
      tokenUsage: source.token_usage, createdAt: source.created_at, updatedAt: source.updated_at,
    };
    const parsed = parseOutputMessage(sourceMessage);
    const evaluation = evaluateGraph(graph, question.node_id, parsed.output);
    if (evaluation.kind === "dispatch") {
      await enqueueNode(transaction, {
        runId: message.runId, spec: asJsonObject(question.spec, "workflow run spec"),
        node: evaluation.node, sourceMessage, sourceOutput: parsed.output,
        inheritedTicketId: question.ticket_id,
      });
    }
  }
  await finishRunIfIdle(transaction, message.runId);
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
  if (message.type === "question") {
    await transaction.query("SAVEPOINT workflow_question_route");
    try {
      await routeQuestionMessage(transaction, message);
      await transaction.query("RELEASE SAVEPOINT workflow_question_route");
    } catch (error) {
      if (!(error instanceof WorkflowGraphError) && !(error instanceof TypeError)) throw error;
      await transaction.query("ROLLBACK TO SAVEPOINT workflow_question_route");
      await transaction.query("RELEASE SAVEPOINT workflow_question_route");
      await failRun(transaction, message.runId, "workflow_question_invalid", boundedReason(error));
    }
    return;
  }
  if (message.type === "answer") {
    await transaction.query("SAVEPOINT workflow_answer_route");
    try {
      await routeAnswerMessage(transaction, message);
      await transaction.query("RELEASE SAVEPOINT workflow_answer_route");
    } catch (error) {
      if (!(error instanceof WorkflowGraphError) && !(error instanceof TypeError)) throw error;
      await transaction.query("ROLLBACK TO SAVEPOINT workflow_answer_route");
      await transaction.query("RELEASE SAVEPOINT workflow_answer_route");
      await insertMessage(transaction, {
        runId: message.runId, ticketId: message.ticketId,
        sender: "system:workflow-engine", recipient: "system:operators", type: "system",
        payload: { code: "workflow_answer_rejected", message: boundedReason(error), answerMessageId: message.id },
      });
    }
    return;
  }
  if (message.type === "cron_tick") {
    cronTickForEngine(message);
    const run = await transaction.query<{ trigger_type: string }>(
      "SELECT trigger_type FROM workflow_runs WHERE id = $1 FOR UPDATE",
      [message.runId],
    );
    if (!run.rows[0]) throw new WorkflowStateError(`run ${message.runId} disappeared`);
    if (run.rows[0].trigger_type !== "cron") throw new WorkflowStateError("cron tick belongs to a non-cron run");
    await startWorkflowRunInTransaction(transaction, message.runId);
    return;
  }
  if (message.type === "channel_inbound") {
    await routeChannelInbound(transaction, message);
    return;
  }
  if (message.type === "system" && await routeChannelCompletionEvent(transaction, message)) return;
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
    const intake = await handleChannelIntakeOutput(
      transaction,
      run,
      dispatch,
      parsed.output,
    );
    const evaluation =
      intake.kind === "waiting" || intake.kind === "already_ready"
        ? null
        : evaluateGraph(graph, dispatch.node_id, parsed.output);
    const runSpec = intake.kind === "ready" ? intake.spec : run.spec;

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
    await routeScheduledStandup(transaction, run, message, parsed);
    if (intake.kind === "waiting" || intake.kind === "already_ready") return;
    await materializeFanoutCapacity(transaction, message.runId, dispatch.node_id);
    const completedNode = graph.nodes.find((node) => node.id === dispatch.node_id)!;
    if (completedNode.config.approvalGates?.pauseAfter === true) {
      await openWorkflowQuestion(transaction, {
        runId: message.runId, ticketId: dispatch.ticket_id, dispatchId: dispatch.id,
        node: completedNode, kind: "approval", boundary: "after",
        text: `Approve the result of workflow node ${completedNode.id}?`,
        sender: "system:workflow-engine",
      });
      return;
    }
    if (evaluation?.kind === "dispatch") {
      await enqueueNode(transaction, {
        runId: message.runId,
        spec: runSpec,
        node: evaluation.node,
        sourceMessage: message,
        sourceOutput: parsed.output,
        inheritedTicketId: dispatch.ticket_id,
      });
    }
    await finishRunIfIdle(transaction, message.runId);
  } catch (error) {
    if (!(error instanceof WorkflowGraphError) && !(error instanceof TypeError)) throw error;
    await transaction.query(
      `UPDATE channel_intakes
       SET status = 'failed', last_question = NULL, updated_at = clock_timestamp()
       WHERE run_id = $1 AND status = 'collecting'`,
      [message.runId],
    );
    await failRun(
      transaction,
      message.runId,
      "workflow_evaluation_failed",
      boundedReason(error),
    );
  }
}

/** A scheduled standup reuses the same durable Telegram outbound queue as an agent reply. */
async function routeScheduledStandup(
  transaction: PoolClient,
  run: { spec: unknown },
  message: MessageRow,
  output: { output: JsonObject },
): Promise<void> {
  const spec = asJsonObject(run.spec, "workflow run spec");
  const schedule = spec.schedule;
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule) || spec.standup === undefined) return;
  const chat = await transaction.query<{ chat_id: string }>(
    `SELECT payload #>> '{chat,id}' AS chat_id
     FROM messages
     WHERE type = 'channel_inbound' AND payload ->> 'provider' = 'telegram'
       AND payload #>> '{chat,id}' IS NOT NULL
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  if (!chat.rows[0]) return;
  const text = message.handoffBrief?.trim()
    || (typeof output.output.summary === "string" ? output.output.summary.trim() : "Daily standup complete.");
  await insertMessage(transaction, {
    runId: message.runId,
    sender: "system:daily-standup",
    recipient: `telegram:chat:${chat.rows[0].chat_id}`,
    type: "channel_outbound",
    payload: { provider: "telegram", chatId: chat.rows[0].chat_id, text },
  });
}

/**
 * Channel starts remain ordinary durable bus events. The inbound row is the
 * source message for the entry dispatch, so the runtime receives both its text
 * handoff and its Telegram reply identity through the existing engine input.
 */
async function routeChannelInbound(
  transaction: PoolClient,
  message: MessageRow,
): Promise<void> {
  const runResult = await transaction.query(
    `SELECT run.*, workflow.graph
     FROM workflow_runs AS run
     JOIN workflows AS workflow ON workflow.id = run.workflow_id
     WHERE run.id = $1
     FOR UPDATE OF run, workflow`,
    [message.runId],
  );
  if (!runResult.rows[0]) throw new WorkflowStateError(`run ${message.runId} disappeared`);
  const run = runResult.rows[0];
  if (!(run.status === "pending" || run.status === "running")) return;

  try {
    const inbound = telegramInboundForEngine(message);
    if (run.trigger_type !== "channel") {
      throw new WorkflowGraphError("channel inbound message belongs to a non-channel run");
    }
    const graph = parseWorkflowGraph(run.graph);
    const entryNode = graph.nodes.find((node) => node.id === workflowEntryNodeId(graph))!;
    if (entryNode.config.channelBinding !== true) {
      throw new WorkflowGraphError("channel workflow entry is not channel-bound");
    }
    if (message.recipient !== `agent:${entryNode.agentId}`) {
      throw new WorkflowGraphError("channel inbound recipient does not match workflow entry agent");
    }
    if (channelStatusRequestForEngine(message)) {
      await routeChannelStatusRequest(transaction, message);
      return;
    }
    if (run.status === "pending") {
      await transaction.query(
        `UPDATE workflow_runs
         SET status = 'running', graph_snapshot = $2, started_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [message.runId, run.graph],
      );
    } else {
      const intake = await transaction.query<{ status: string }>(
        "SELECT status FROM channel_intakes WHERE run_id = $1 FOR UPDATE",
        [message.runId],
      );
      if (intake.rows[0]?.status !== "collecting") return;
    }
    const inserted = await enqueueNode(transaction, {
      runId: message.runId,
      spec: asJsonObject(run.spec, "workflow run spec"),
      node: entryNode,
      sourceMessage: message,
      sourceOutput: inbound,
      inheritedTicketId: null,
    });
    if (inserted === 0) {
      const completed = await transaction.query(
        `UPDATE workflow_runs
         SET status = 'completed', ended_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1 AND status IN ('running', 'paused')`,
        [message.runId],
      );
      if (completed.rowCount === 1) await enqueueChannelCompletionEvent(transaction, message.runId);
    }
  } catch (error) {
    if (!(error instanceof WorkflowGraphError) && !(error instanceof TypeError)) throw error;
    await failRun(transaction, message.runId, "channel_inbound_invalid", boundedReason(error));
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
    onOperational?: () => void;
  },
): Promise<void> {
  const pollIntervalMs = interval(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    "pollIntervalMs",
  );
  let operational = false;
  while (!options.signal?.aborted) {
    const dispatched = await dispatchNextWorkflowNode(pool, runtime, options);
    if (!operational) {
      operational = true;
      options.onOperational?.();
    }
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
  let markMessageOperational!: () => void;
  let markDispatchOperational!: () => void;
  const messageOperational = new Promise<void>((resolve) => { markMessageOperational = resolve; });
  const dispatchOperational = new Promise<void>((resolve) => { markDispatchOperational = resolve; });
  const messageWorker = runMessageBusWorker(pool, routeWorkflowMessage, {
    consumerId: nonBlank(options.consumerId, "consumerId"),
    signal: controller.signal,
    pollIntervalMs: options.pollIntervalMs,
    retryIntervalMs: options.retryIntervalMs,
    onOperational: markMessageOperational,
  });
  const dispatchWorker = runWorkflowDispatchWorker(pool, runtime, {
    workerId: nonBlank(options.dispatcherId, "dispatcherId"),
    signal: controller.signal,
    pollIntervalMs: options.pollIntervalMs,
    leaseMs: options.dispatchLeaseMs,
    onOperational: markDispatchOperational,
  });
  let rejectScheduler!: (error: unknown) => void;
  const schedulerFailure = new Promise<never>((_resolve, reject) => {
    rejectScheduler = reject;
  });
  const scheduler: ScheduleWorker = startScheduleWorker(pool, (error) => {
    controller.abort();
    rejectScheduler(error);
    void scheduler.stop();
  });
  const done = Promise.race([
    Promise.all([messageWorker, dispatchWorker, scheduler.done]).then(() => undefined),
    schedulerFailure,
  ]);
  const operational = Promise.all([messageOperational, dispatchOperational]).then(() => undefined);
  const ready = Promise.race([
    operational,
    done.then(() => { throw new Error("workflow engine stopped before becoming operational"); }),
  ]);
  void done.catch(() => controller.abort());
  return {
    ready,
    done,
    async stop() {
      controller.abort();
      await scheduler.stop();
      await done;
    },
  };
}
