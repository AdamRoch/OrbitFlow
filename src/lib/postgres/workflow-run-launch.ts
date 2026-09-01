import type { PoolClient, QueryResultRow } from "pg";
import {
  WorkflowGraphError,
  parseWorkflowGraph,
  type JsonObject,
  type WorkflowGraph,
} from "../workflow/graph.ts";

export type WorkflowRunTrigger = "channel" | "ui" | "cron";

function positiveId(value: string | number | bigint, field: string): string {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return text;
}

async function requireGraphAgents(
  transaction: PoolClient,
  graph: WorkflowGraph,
): Promise<void> {
  const agentIds = [...new Set(graph.nodes.map((node) => String(node.agentId)))];
  const agents = await transaction.query<{ id: string }>(
    "SELECT id FROM agents WHERE id = ANY($1::bigint[]) FOR KEY SHARE",
    [agentIds],
  );
  if (agents.rowCount !== agentIds.length) {
    throw new WorkflowGraphError("workflow graph references an agent that does not exist");
  }
}

export async function insertValidatedWorkflowRun(
  transaction: PoolClient,
  input: {
    workflowId: string | number | bigint;
    triggerType: WorkflowRunTrigger;
    spec: JsonObject;
  },
): Promise<QueryResultRow> {
  const workflowId = positiveId(input.workflowId, "workflowId");
  const workflow = await transaction.query<{
    graph: JsonObject;
    updated_at: string | Date;
  }>(
    "SELECT graph, updated_at FROM workflows WHERE id = $1 FOR KEY SHARE",
    [workflowId],
  );
  if (!workflow.rows[0]) throw new WorkflowGraphError(`workflow ${workflowId} not found`);

  const graph = parseWorkflowGraph(workflow.rows[0].graph);
  await requireGraphAgents(transaction, graph);
  const inserted = await transaction.query(
    `INSERT INTO workflow_runs (
       workflow_id, trigger_type, spec, graph_snapshot, workflow_version
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [workflowId, input.triggerType, input.spec, graph, workflow.rows[0].updated_at],
  );
  return inserted.rows[0]!;
}

export async function insertWorkflowRetry(
  transaction: PoolClient,
  source: QueryResultRow,
  retryRequestKey: string,
): Promise<QueryResultRow> {
  const graph = parseWorkflowGraph(source.graph_snapshot);
  await requireGraphAgents(transaction, graph);
  const inserted = await transaction.query(
    `INSERT INTO workflow_runs (
       workflow_id, trigger_type, spec, graph_snapshot, workflow_version,
       retry_of_run_id, retry_request_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      source.workflow_id,
      "ui",
      source.spec,
      graph,
      source.workflow_version,
      source.id,
      retryRequestKey,
    ],
  );
  return inserted.rows[0]!;
}
