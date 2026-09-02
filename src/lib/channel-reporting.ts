import type { PoolClient, QueryResultRow } from "pg";
import { insertMessage, type JsonObject, type MessageRow } from "./postgres/message-bus.ts";
import { asJsonObject, parseWorkflowGraph, workflowEntryNodeId } from "./workflow/graph-contract.ts";

const STATUS_REQUEST = /^(?:how(?:'s| is) (?:it|the (?:run|work)) going(?:[?!.,].*)?|(?:run )?status[?!.,]*|progress[?!.,]*|what(?:'s| is) (?:the )?(?:run )?status[?!.,]*)$/i;

function countSummary(rows: QueryResultRow[]): string {
  return rows.length === 0
    ? "none"
    : rows.map((row) => `${row.count} ${row.status}`).join(", ");
}

interface ReportContext extends QueryResultRow {
  run_id: string;
  run_status: string;
  workflow_name: string;
  total_tokens: string;
  total_cost: string;
  conversation_key: string;
  graph_snapshot: JsonObject;
}

async function reportContext(transaction: PoolClient, runId: string): Promise<ReportContext | null> {
  const result = await transaction.query<ReportContext>(
    `SELECT run.id AS run_id, run.status::text AS run_status, workflow.name AS workflow_name,
            run.total_tokens::text, run.total_cost::text, intake.conversation_key, run.graph_snapshot
     FROM workflow_runs AS run
     JOIN workflows AS workflow ON workflow.id = run.workflow_id
     JOIN channel_intakes AS intake ON intake.run_id = run.id
     WHERE run.id = $1
     FOR KEY SHARE OF run, workflow, intake`,
    [runId],
  );
  return result.rows[0] ?? null;
}

async function buildReportText(transaction: PoolClient, context: ReportContext, final: boolean): Promise<string> {
  const tickets = await transaction.query<{ status: string; count: string }>(
    `SELECT status::text, count(*)::text AS count
     FROM tickets WHERE run_id = $1 GROUP BY status ORDER BY status`,
    [context.run_id],
  );
  const dispatches = await transaction.query<{ status: string; count: string }>(
    `SELECT status::text, count(*)::text AS count
     FROM workflow_dispatches WHERE run_id = $1 GROUP BY status ORDER BY status`,
    [context.run_id],
  );
  const result = await transaction.query<{ handoff_brief: string | null }>(
    `SELECT handoff_brief
     FROM messages
     WHERE run_id = $1 AND type = 'output' AND handoff_brief IS NOT NULL
     ORDER BY sequence_number DESC LIMIT 1`,
    [context.run_id],
  );
  const heading = final ? "Final report" : "Status";
  const retainedResult = result.rows[0]?.handoff_brief?.trim() || "No retained agent result.";
  const spend = context.total_cost.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
  return `${heading} for ${context.workflow_name} run #${context.run_id}: ${context.run_status}. Tickets: ${countSummary(tickets.rows)}. Dispatches: ${countSummary(dispatches.rows)}. Spend: $${spend} across ${context.total_tokens} tokens. Latest retained result: ${retainedResult}`;
}

/** A deliberately finite classifier, not a general natural-language intent layer. */
export function isChannelStatusRequest(text: string): boolean {
  return STATUS_REQUEST.test(text.trim());
}

export function channelStatusRequestForEngine(message: MessageRow): boolean {
  return message.type === "channel_inbound" && message.payload.channelRequest === "status";
}

/** Persist a grounded, deterministic status response through the normal outbound bus. */
export async function routeChannelStatusRequest(
  transaction: PoolClient,
  message: MessageRow,
): Promise<boolean> {
  const context = await reportContext(transaction, message.runId);
  if (!context || !["running", "paused"].includes(context.run_status)) return false;
  const text = await buildReportText(transaction, context, false);
  const graph = parseWorkflowGraph(asJsonObject(context.graph_snapshot, "workflow run graph snapshot"));
  const agentId = graph.nodes.find((node) => node.id === workflowEntryNodeId(graph))!.agentId.toString();
  await insertMessage(transaction, {
    runId: message.runId,
    sender: `agent:${agentId}`,
    recipient: `telegram:chat:${context.conversation_key}`,
    type: "channel_outbound",
    payload: { provider: "telegram", chatId: context.conversation_key, text },
    handoffBrief: text,
  });
  return true;
}

/** Create the one retained completion wake after a channel run reaches completed. */
export async function enqueueChannelCompletionEvent(
  transaction: PoolClient,
  runId: string,
): Promise<void> {
  const run = await transaction.query<{ status: string; trigger_type: string; graph_snapshot: JsonObject }>(
    "SELECT status::text, trigger_type::text, graph_snapshot FROM workflow_runs WHERE id = $1 FOR UPDATE",
    [runId],
  );
  if (!run.rows[0] || run.rows[0].trigger_type !== "channel" || run.rows[0].status !== "completed") return;
  const existing = await transaction.query(
    "SELECT run_id FROM channel_completion_events WHERE run_id = $1 FOR KEY SHARE",
    [runId],
  );
  if (existing.rowCount) return;
  const graph = parseWorkflowGraph(asJsonObject(run.rows[0].graph_snapshot, "workflow run graph snapshot"));
  const agentId = graph.nodes.find((node) => node.id === workflowEntryNodeId(graph))!.agentId.toString();
  const event = await insertMessage(transaction, {
    runId,
    sender: "system:workflow-engine",
    recipient: `agent:${agentId}`,
    type: "system",
    payload: { kind: "channel_run_completed", version: 1 },
    handoffBrief: "Channel workflow completed; prepare the retained final report.",
  });
  await transaction.query(
    "INSERT INTO channel_completion_events (run_id, completion_message_id) VALUES ($1, $2)",
    [runId, event.id],
  );
}

/** Consume a completion wake exactly once logically, producing one durable Telegram reply. */
export async function routeChannelCompletionEvent(
  transaction: PoolClient,
  message: MessageRow,
): Promise<boolean> {
  if (message.type !== "system" || message.payload.kind !== "channel_run_completed") return false;
  const event = await transaction.query<{ final_outbound_message_id: string | null }>(
    `SELECT final_outbound_message_id
     FROM channel_completion_events
     WHERE run_id = $1 AND completion_message_id = $2
     FOR UPDATE`,
    [message.runId, message.id],
  );
  if (!event.rows[0] || event.rows[0].final_outbound_message_id) return true;
  const context = await reportContext(transaction, message.runId);
  if (!context || context.run_status !== "completed") return true;
  const text = await buildReportText(transaction, context, true);
  const graph = parseWorkflowGraph(asJsonObject(context.graph_snapshot, "workflow run graph snapshot"));
  const agentId = graph.nodes.find((node) => node.id === workflowEntryNodeId(graph))!.agentId.toString();
  const outbound = await insertMessage(transaction, {
    runId: message.runId,
    sender: `agent:${agentId}`,
    recipient: `telegram:chat:${context.conversation_key}`,
    type: "channel_outbound",
    payload: { provider: "telegram", chatId: context.conversation_key, text },
    handoffBrief: text,
  });
  await transaction.query(
    `UPDATE channel_completion_events
     SET final_outbound_message_id = $2, reported_at = clock_timestamp()
     WHERE run_id = $1 AND final_outbound_message_id IS NULL`,
    [message.runId, outbound.id],
  );
  return true;
}
