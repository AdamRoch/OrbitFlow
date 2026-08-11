import cron from "node-cron";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { insertMessage, type JsonObject, type MessageRow } from "./message-bus.ts";

export type ScheduleTickResult =
  | { kind: "created"; scheduleId: string; tickKey: string; runId: string; messageId: string }
  | { kind: "duplicate"; scheduleId: string; tickKey: string; runId: string; messageId: string }
  | { kind: "disabled"; scheduleId: string };

export interface ScheduleWorker {
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

interface ScheduleRow extends QueryResultRow {
  id: string;
  cron_expression: string;
  workflow_id: string | null;
  agent_id: string | null;
  task_prompt: string | null;
  enabled: boolean;
}

function positiveId(value: string | number | bigint, field: string): string {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) throw new TypeError(`${field} must be a positive integer`);
  return text;
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} must be a non-blank string`);
  return value.trim();
}

async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function minuteKey(at: Date): string {
  if (!Number.isFinite(at.getTime())) throw new TypeError("at must be a valid Date");
  return at.toISOString().slice(0, 16) + "Z";
}

/** Kept as a deterministic clock seam; node-cron owns the real minute boundary. */
export function cronMatches(expression: string, at: Date): boolean {
  if (!cron.validate(expression)) return false;
  const matcher = cron.createTask(expression, () => undefined, { timezone: "UTC" });
  try {
    return matcher.match(at);
  } finally {
    void matcher.destroy();
  }
}

async function executionWorkflow(transaction: PoolClient, schedule: ScheduleRow): Promise<string> {
  if (schedule.workflow_id) return schedule.workflow_id;
  const existing = await transaction.query<{ workflow_id: string }>(
    "SELECT workflow_id FROM schedule_agent_workflows WHERE schedule_id = $1 FOR KEY SHARE",
    [schedule.id],
  );
  if (existing.rows[0]) return existing.rows[0].workflow_id;
  const graph = { nodes: [{ id: "scheduled-agent", agentId: schedule.agent_id!, config: { entry: true } }], edges: [] };
  const workflow = await transaction.query<{ id: string }>(
    `INSERT INTO workflows (name, description, graph)
     VALUES ($1, $2, $3) RETURNING id`,
    [`Scheduled agent wake ${schedule.id}`, "Private one-node workflow for a persisted agent schedule.", graph],
  );
  await transaction.query(
    `INSERT INTO schedule_agent_workflows (schedule_id, workflow_id)
     VALUES ($1, $2) ON CONFLICT (schedule_id) DO NOTHING`,
    [schedule.id, workflow.rows[0]!.id],
  );
  const winner = await transaction.query<{ workflow_id: string }>(
    "SELECT workflow_id FROM schedule_agent_workflows WHERE schedule_id = $1",
    [schedule.id],
  );
  return winner.rows[0]!.workflow_id;
}

async function standupInputs(transaction: PoolClient, at: Date): Promise<JsonObject> {
  const since = new Date(at.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const [tickets, spend] = await Promise.all([
    transaction.query<{ count: string }>("SELECT count(*)::text AS count FROM tickets WHERE updated_at >= $1::timestamptz", [since]),
    transaction.query<{ amount: string }>("SELECT COALESCE(SUM(computed_cost), 0)::text AS amount FROM cost_events WHERE created_at >= $1::timestamptz", [since]),
  ]);
  return { windowStart: since, ticketMovement: { updatedTickets: tickets.rows[0]!.count }, spend: { totalCost: spend.rows[0]!.amount } };
}

function isStandup(schedule: ScheduleRow): boolean {
  return schedule.task_prompt?.startsWith("Daily standup:") === true;
}

/** Atomically creates the target run and its visible cron_tick envelope. */
export async function publishScheduleTick(
  pool: Pool,
  input: { scheduleId: string | number | bigint; tickKey: string; at?: Date; source: "clock" | "manual" },
): Promise<ScheduleTickResult> {
  const scheduleId = positiveId(input.scheduleId, "scheduleId");
  const tickKey = nonBlank(input.tickKey, "tickKey");
  const at = input.at ?? new Date();
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`orbitflow:schedule:${scheduleId}:${tickKey}`]);
    const scheduleResult = await client.query<ScheduleRow>("SELECT * FROM schedules WHERE id = $1 FOR UPDATE", [scheduleId]);
    const schedule = scheduleResult.rows[0];
    if (!schedule) throw new Error(`schedule ${scheduleId} not found`);
    if (!schedule.enabled) return { kind: "disabled", scheduleId };
    const previous = await client.query<{ run_id: string; message_id: string }>(
      "SELECT run_id, message_id FROM schedule_ticks WHERE schedule_id = $1 AND tick_key = $2",
      [scheduleId, tickKey],
    );
    if (previous.rows[0]) return { kind: "duplicate", scheduleId, tickKey, runId: previous.rows[0].run_id, messageId: previous.rows[0].message_id };
    const workflowId = await executionWorkflow(client, schedule);
    const standup = isStandup(schedule) ? await standupInputs(client, at) : null;
    const spec: JsonObject = {
      schedule: { id: scheduleId, tickKey, source: input.source, ...(schedule.agent_id ? { agentId: schedule.agent_id, standingTask: schedule.task_prompt! } : {}) },
      ...(standup ? { standup } : {}),
    };
    const run = await client.query<{ id: string }>(
      "INSERT INTO workflow_runs (workflow_id, trigger_type, spec) VALUES ($1, 'cron', $2) RETURNING id",
      [workflowId, spec],
    );
    const message = await insertMessage(client, {
      runId: run.rows[0]!.id,
      sender: "system:scheduler",
      recipient: "system:workflow-engine",
      type: "cron_tick",
      payload: { scheduleId, tickKey, source: input.source, target: schedule.workflow_id ? "workflow" : "agent", at: at.toISOString() },
      handoffBrief: schedule.task_prompt,
    });
    await client.query(
      "INSERT INTO schedule_ticks (schedule_id, tick_key, run_id, message_id) VALUES ($1, $2, $3, $4)",
      [scheduleId, tickKey, run.rows[0]!.id, message.id],
    );
    return { kind: "created", scheduleId, tickKey, runId: run.rows[0]!.id, messageId: message.id };
  });
}

export async function processDueSchedules(pool: Pool, at = new Date()): Promise<ScheduleTickResult[]> {
  const schedules = await pool.query<ScheduleRow>("SELECT * FROM schedules WHERE enabled ORDER BY id");
  const tickKey = minuteKey(at);
  const results: ScheduleTickResult[] = [];
  for (const schedule of schedules.rows) {
    if (cronMatches(schedule.cron_expression, at)) results.push(await publishScheduleTick(pool, { scheduleId: schedule.id, tickKey, at, source: "clock" }));
  }
  return results;
}

export async function triggerScheduleManually(pool: Pool, scheduleId: string | number | bigint, idempotencyKey: string, at = new Date()) {
  return publishScheduleTick(pool, { scheduleId, tickKey: `manual:${nonBlank(idempotencyKey, "idempotencyKey")}`, at, source: "manual" });
}

/** node-cron owns production clock delivery.  The database is reread every tick. */
export function startScheduleWorker(pool: Pool, onError: (error: unknown) => void = () => undefined): ScheduleWorker {
  const task = cron.schedule("* * * * *", () => {
    void processDueSchedules(pool).catch(onError);
  }, { timezone: "UTC", noOverlap: true });
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  return { done, async stop() { task.stop(); task.destroy(); resolveDone?.(); } };
}

export function cronTickForEngine(message: MessageRow): void {
  if (message.type !== "cron_tick") throw new TypeError("message must be cron_tick");
  if (message.sender !== "system:scheduler" || message.recipient !== "system:workflow-engine") throw new TypeError("cron tick route is invalid");
}
