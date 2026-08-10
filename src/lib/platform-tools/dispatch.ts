import { createHash } from "node:crypto";
import { types } from "pg";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { insertMessage, type JsonObject, type MessageRow, type MessageType } from "../postgres/message-bus.ts";

export const PLATFORM_TOOL_COMMANDS = [
  "create_ticket",
  "update_ticket",
  "post_message",
  "list_tickets",
] as const;

export type PlatformToolCommand = (typeof PLATFORM_TOOL_COMMANDS)[number];
type TicketStatus = "backlog" | "todo" | "in_progress" | "done" | "canceled";

interface Attribution {
  agentId: string;
  runId: string;
}

interface TicketDTO {
  id: string;
  number: string;
  identifier: string;
  projectId: string;
  runId: string | null;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  status: TicketStatus;
  priority: number;
  assigneeAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MessageDTO {
  id: string;
  runId: string;
  ticketId: string | null;
  sequenceNumber: string;
  sender: string;
  recipient: string;
  type: MessageType;
  payload: JsonObject;
  handoffBrief: string | null;
  createdAt: string;
}

export type PlatformToolResult =
  | { ticket: TicketDTO; message: MessageDTO; replayed: boolean }
  | { message: MessageDTO; replayed: boolean }
  | { tickets: TicketDTO[]; nextCursor: string | null };

export class PlatformToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type CreateTicketInput = Attribution & {
  command: "create_ticket";
  projectId: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  status: TicketStatus;
  priority: number;
  idempotencyKey: string;
};

type UpdateTicketInput = Attribution & {
  command: "update_ticket";
  ticketId: string;
  expectedUpdatedAt: string;
  title?: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
  status?: TicketStatus;
  priority?: number;
  idempotencyKey: string;
};

type PostMessageInput = Attribution & {
  command: "post_message";
  ticketId: string;
  recipient: string;
  type: MessageType;
  payload: JsonObject;
  handoffBrief: string | null;
  idempotencyKey: string;
};

type ListTicketsInput = Attribution & {
  command: "list_tickets";
  projectId?: string;
  status?: TicketStatus;
  limit: number;
  afterId?: string;
};

type ParsedInput = CreateTicketInput | UpdateTicketInput | PostMessageInput | ListTicketsInput;
type MutationInput = CreateTicketInput | UpdateTicketInput | PostMessageInput;
type Row = Record<string, unknown>;

const TICKET_STATUSES = new Set<TicketStatus>(["backlog", "todo", "in_progress", "done", "canceled"]);
const MESSAGE_TYPES = new Set<MessageType>([
  "output", "feedback", "question", "answer", "channel_inbound", "channel_outbound", "cron_tick", "system",
]);
const MAX_TEXT_LENGTH = 12_000;
const MAX_PAYLOAD_BYTES = 16_384;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

// A version value must round-trip at PostgreSQL's microsecond precision. Date
// conversion would silently turn a valid optimistic-lock precondition stale.
types.setTypeParser(1184, (value) => value);

function object(value: unknown, field = "input"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformToolError("invalid_type", `${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function knownFields(value: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) {
      throw new PlatformToolError("unknown_field", `unknown field: ${field}`);
    }
  }
}

function id(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return value;
  throw new PlatformToolError("invalid_id", `${field} must be a positive integer`);
}

function requiredString(value: unknown, field: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") throw new PlatformToolError("invalid_type", `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new PlatformToolError("empty", `${field} must not be blank`);
  if (trimmed.length > maxLength) throw new PlatformToolError("too_large", `${field} exceeds ${maxLength} characters`);
  return trimmed;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, field);
}

function optionalText(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  return nullableText(value, field);
}

function status(value: unknown, field = "status"): TicketStatus {
  if (typeof value !== "string" || !TICKET_STATUSES.has(value as TicketStatus)) {
    throw new PlatformToolError("invalid_status", `${field} must be a ticket status`);
  }
  return value as TicketStatus;
}

function optionalStatus(value: unknown): TicketStatus | undefined {
  if (value === undefined) return undefined;
  return status(value);
}

function priority(value: unknown, required: boolean): number | undefined {
  if (value === undefined) {
    if (required) throw new PlatformToolError("missing", "priority is required");
    return undefined;
  }
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > 4) {
    throw new PlatformToolError("invalid_priority", "priority must be an integer from 0 to 4");
  }
  return value;
}

function jsonObject(value: unknown, field: string): JsonObject {
  const candidate = object(value, field);
  try {
    const serialized = JSON.stringify(candidate);
    if (typeof serialized !== "string") throw new Error("not serializable");
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      throw new PlatformToolError("too_large", `${field} exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }
    return JSON.parse(serialized) as JsonObject;
  } catch (error) {
    if (error instanceof PlatformToolError) throw error;
    throw new PlatformToolError("invalid_json", `${field} must contain JSON values`);
  }
}

function attribution(value: Record<string, unknown>): Attribution {
  return { agentId: id(value.agentId, "agentId"), runId: id(value.runId, "runId") };
}

function idempotencyKey(value: unknown): string {
  return requiredString(value, "idempotencyKey", MAX_IDEMPOTENCY_KEY_LENGTH);
}

function expectedUpdatedAt(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new PlatformToolError("invalid_timestamp", "expectedUpdatedAt must be an ISO-8601 timestamp");
  }
  return value;
}

function parseInput(command: PlatformToolCommand, value: unknown): ParsedInput {
  const input = object(value);
  const base = ["agentId", "runId"];
  if (command === "create_ticket") {
    knownFields(input, [...base, "projectId", "title", "description", "acceptanceCriteria", "status", "priority", "idempotencyKey"]);
    return {
      command, ...attribution(input), projectId: id(input.projectId, "projectId"), title: requiredString(input.title, "title"),
      description: nullableText(input.description, "description"), acceptanceCriteria: nullableText(input.acceptanceCriteria, "acceptanceCriteria"),
      status: input.status === undefined ? "backlog" : status(input.status), priority: priority(input.priority ?? 0, true)!,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
    };
  }
  if (command === "update_ticket") {
    knownFields(input, [...base, "ticketId", "expectedUpdatedAt", "title", "description", "acceptanceCriteria", "status", "priority", "idempotencyKey"]);
    const title = input.title === undefined ? undefined : requiredString(input.title, "title");
    const description = optionalText(input.description, "description");
    const acceptanceCriteria = optionalText(input.acceptanceCriteria, "acceptanceCriteria");
    const nextStatus = optionalStatus(input.status);
    const nextPriority = priority(input.priority, false);
    if ([title, description, acceptanceCriteria, nextStatus, nextPriority].every((field) => field === undefined)) {
      throw new PlatformToolError("missing", "update_ticket requires at least one ticket field");
    }
    return {
      command, ...attribution(input), ticketId: id(input.ticketId, "ticketId"), expectedUpdatedAt: expectedUpdatedAt(input.expectedUpdatedAt),
      ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }),
      ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }), ...(nextStatus === undefined ? {} : { status: nextStatus }),
      ...(nextPriority === undefined ? {} : { priority: nextPriority }), idempotencyKey: idempotencyKey(input.idempotencyKey),
    };
  }
  if (command === "post_message") {
    knownFields(input, [...base, "ticketId", "recipient", "type", "payload", "handoffBrief", "idempotencyKey"]);
    if (typeof input.type !== "string" || !MESSAGE_TYPES.has(input.type as MessageType)) {
      throw new PlatformToolError("invalid_message_type", "type must be a supported message type");
    }
    return {
      command, ...attribution(input), ticketId: id(input.ticketId, "ticketId"), recipient: requiredString(input.recipient, "recipient", 256),
      type: input.type as MessageType, payload: jsonObject(input.payload, "payload"), handoffBrief: nullableText(input.handoffBrief, "handoffBrief"),
      idempotencyKey: idempotencyKey(input.idempotencyKey),
    };
  }
  knownFields(input, [...base, "projectId", "status", "limit", "afterId"]);
  const limit = input.limit === undefined ? 50 : input.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new PlatformToolError("invalid_limit", "limit must be an integer from 1 to 100");
  }
  return {
    command, ...attribution(input), ...(input.projectId === undefined ? {} : { projectId: id(input.projectId, "projectId") }),
    ...(input.status === undefined ? {} : { status: status(input.status) }), limit,
    ...(input.afterId === undefined ? {} : { afterId: id(input.afterId, "afterId") }),
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function requestHash(input: MutationInput): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
}

function ticketFromRow(row: Row): TicketDTO {
  return {
    id: String(row.id), number: String(row.number), identifier: String(row.identifier), projectId: String(row.project_id),
    runId: row.run_id === null ? null : String(row.run_id), title: String(row.title), description: row.description === null ? null : String(row.description),
    acceptanceCriteria: row.acceptance_criteria === null ? null : String(row.acceptance_criteria), status: row.status as TicketStatus,
    priority: Number(row.priority), assigneeAgentId: row.assignee_agent_id === null ? null : String(row.assignee_agent_id),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function messageFromRow(row: MessageRow): MessageDTO {
  return {
    id: row.id, runId: row.runId, ticketId: row.ticketId, sequenceNumber: row.sequenceNumber,
    sender: row.sender, recipient: row.recipient, type: row.type, payload: row.payload,
    handoffBrief: row.handoffBrief, createdAt: iso(row.createdAt),
  };
}

async function one<R extends QueryResultRow>(client: PoolClient, sql: string, values: unknown[]): Promise<R | null> {
  const result = await client.query<R>(sql, values);
  return result.rows[0] ?? null;
}

async function requireAttribution(client: PoolClient, input: Attribution): Promise<void> {
  const actor = await one<Row>(client, "SELECT id FROM agents WHERE id = $1", [input.agentId]);
  if (!actor) throw new PlatformToolError("agent_not_found", "agentId does not identify an agent");
  const run = await one<Row>(client, "SELECT id FROM workflow_runs WHERE id = $1", [input.runId]);
  if (!run) throw new PlatformToolError("run_not_found", "runId does not identify a workflow run");
}

async function requireTicketForRun(client: PoolClient, ticketId: string, runId: string): Promise<Row> {
  const ticket = await one<Row>(client, "SELECT * FROM tickets WHERE id = $1 FOR UPDATE", [ticketId]);
  if (!ticket) throw new PlatformToolError("ticket_not_found", "ticketId does not identify a ticket");
  if (String(ticket.run_id) !== runId) {
    throw new PlatformToolError("ticket_run_mismatch", "ticketId is not attributed to runId");
  }
  return ticket;
}

async function createTicket(client: PoolClient, input: CreateTicketInput): Promise<PlatformToolResult> {
  const project = await one<Row>(
    client,
    `UPDATE projects SET next_number = next_number + 1, updated_at = now()
     WHERE id = $1 RETURNING key, next_number`,
    [input.projectId],
  );
  if (!project) throw new PlatformToolError("project_not_found", "projectId does not identify a project");
  const ticket = await one<Row>(
    client,
    `INSERT INTO tickets (
       number, identifier, project_id, run_id, title, description, acceptance_criteria, status, priority, assignee_agent_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [project.next_number, `${project.key}-${project.next_number}`, input.projectId, input.runId, input.title, input.description,
      input.acceptanceCriteria, input.status, input.priority, input.agentId],
  );
  const value = ticketFromRow(ticket!);
  const message = await insertMessage(client, {
    runId: input.runId, ticketId: value.id, sender: `agent:${input.agentId}`, recipient: "system:ticket-stream", type: "system",
    payload: { action: "create_ticket", agentId: input.agentId, runId: input.runId, ticketId: value.id, idempotencyKey: input.idempotencyKey },
  });
  return { ticket: value, message: messageFromRow(message), replayed: false };
}

async function updateTicket(client: PoolClient, input: UpdateTicketInput): Promise<PlatformToolResult> {
  await requireTicketForRun(client, input.ticketId, input.runId);
  const assignments: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };
  if (input.title !== undefined) add("title", input.title);
  if (input.description !== undefined) add("description", input.description);
  if (input.acceptanceCriteria !== undefined) add("acceptance_criteria", input.acceptanceCriteria);
  if (input.status !== undefined) add("status", input.status);
  if (input.priority !== undefined) add("priority", input.priority);
  values.push(input.ticketId, input.expectedUpdatedAt);
  const ticket = await one<Row>(
    client,
    `UPDATE tickets SET ${assignments.join(", ")}, updated_at = now()
     WHERE id = $${values.length - 1} AND updated_at = $${values.length}::timestamptz RETURNING *`,
    values,
  );
  if (!ticket) throw new PlatformToolError("stale_update", "ticket changed since expectedUpdatedAt");
  const value = ticketFromRow(ticket);
  const message = await insertMessage(client, {
    runId: input.runId, ticketId: value.id, sender: `agent:${input.agentId}`, recipient: "system:ticket-stream", type: "system",
    payload: { action: "update_ticket", agentId: input.agentId, runId: input.runId, ticketId: value.id, idempotencyKey: input.idempotencyKey },
  });
  return { ticket: value, message: messageFromRow(message), replayed: false };
}

async function postMessage(client: PoolClient, input: PostMessageInput): Promise<PlatformToolResult> {
  await requireTicketForRun(client, input.ticketId, input.runId);
  const message = await insertMessage(client, {
    runId: input.runId, ticketId: input.ticketId, sender: `agent:${input.agentId}`, recipient: input.recipient,
    type: input.type, payload: { ...input.payload, agentId: input.agentId, runId: input.runId, ticketId: input.ticketId }, handoffBrief: input.handoffBrief,
  });
  return { message: messageFromRow(message), replayed: false };
}

async function mutate(client: PoolClient, input: MutationInput): Promise<PlatformToolResult> {
  const hash = requestHash(input);
  const inserted = await one<Row>(
    client,
    `INSERT INTO agent_tool_invocations (agent_id, run_id, idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING request_hash`,
    [input.agentId, input.runId, input.idempotencyKey, hash],
  );
  if (!inserted) {
    const prior = await one<Row>(
      client,
      `SELECT request_hash, response FROM agent_tool_invocations
       WHERE agent_id = $1 AND run_id = $2 AND idempotency_key = $3`,
      [input.agentId, input.runId, input.idempotencyKey],
    );
    if (!prior || prior.request_hash !== hash) {
      throw new PlatformToolError("idempotency_key_reused", "idempotencyKey was already used for a different request");
    }
    return { ...(prior.response as PlatformToolResult), replayed: true } as PlatformToolResult;
  }
  const result = input.command === "create_ticket"
    ? await createTicket(client, input)
    : input.command === "update_ticket"
      ? await updateTicket(client, input)
      : await postMessage(client, input);
  await client.query(
    `UPDATE agent_tool_invocations SET response = $4::jsonb, updated_at = clock_timestamp()
     WHERE agent_id = $1 AND run_id = $2 AND idempotency_key = $3`,
    [input.agentId, input.runId, input.idempotencyKey, JSON.stringify(result)],
  );
  return result;
}

async function listTickets(client: PoolClient, input: ListTicketsInput): Promise<PlatformToolResult> {
  const clauses = ["run_id = $1"];
  const values: unknown[] = [input.runId];
  if (input.projectId) {
    values.push(input.projectId);
    clauses.push(`project_id = $${values.length}`);
  }
  if (input.status) {
    values.push(input.status);
    clauses.push(`status = $${values.length}`);
  }
  if (input.afterId) {
    values.push(input.afterId);
    clauses.push(`id > $${values.length}`);
  }
  values.push(input.limit + 1);
  const result = await client.query<Row>(
    `SELECT * FROM tickets WHERE ${clauses.join(" AND ")} ORDER BY id ASC LIMIT $${values.length}`,
    values,
  );
  const rows = result.rows.slice(0, input.limit).map(ticketFromRow);
  return { tickets: rows, nextCursor: result.rows.length > input.limit ? rows.at(-1)?.id ?? null : null };
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
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

/**
 * FACT-13's sole command seam. Future blocked-action policy belongs before the
 * command-specific branch below; no CLI command may bypass this dispatcher.
 */
export async function dispatchPlatformTool(
  pool: Pool,
  command: PlatformToolCommand,
  value: unknown,
): Promise<PlatformToolResult> {
  const input = parseInput(command, value);
  return transaction(pool, async (client) => {
    await requireAttribution(client, input);
    return input.command === "list_tickets" ? listTickets(client, input) : mutate(client, input);
  });
}
