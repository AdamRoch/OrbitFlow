import { setTimeout as delay } from "node:timers/promises";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

export const MESSAGE_TYPES = [
  "output",
  "feedback",
  "question",
  "answer",
  "channel_inbound",
  "channel_outbound",
  "cron_tick",
  "system",
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type DatabaseId = bigint | number | string;

export interface MessageEnvelope {
  runId: DatabaseId;
  ticketId?: DatabaseId | null;
  sender: string;
  recipient: string;
  type: MessageType;
  payload: JsonObject;
  handoffBrief?: string | null;
  tokenUsage?: JsonObject | null;
}

export interface MessageRow {
  id: string;
  runId: string;
  ticketId: string | null;
  sequenceNumber: string;
  sender: string;
  recipient: string;
  type: MessageType;
  payload: JsonObject;
  handoffBrief: string | null;
  tokenUsage: JsonObject | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageConsumption {
  messageId: string;
  consumerId: string;
  consumedAt: Date;
}

export interface ConsumedMessage {
  message: MessageRow;
  consumption: MessageConsumption;
}

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export type DatabaseRoutingHandler = (
  transaction: PoolClient,
  message: MessageRow,
) => Promise<void>;

export interface ConsumeOptions {
  consumerId: string;
}

export interface RunWorkerOptions extends ConsumeOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  retryIntervalMs?: number;
  onError?: (error: unknown) => void | Promise<void>;
}

export interface MessageBusWorker {
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

export class MessageEnvelopeError extends TypeError {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field} ${message}`);
    this.field = field;
    this.name = "MessageEnvelopeError";
  }
}

const MESSAGE_TYPE_SET = new Set<string>(MESSAGE_TYPES);
const MIN_POLL_INTERVAL_MS = 10;
const MAX_POLL_INTERVAL_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_RETRY_INTERVAL_MS = 250;
const CANDIDATE_RUN_LIMIT = 32;

function positiveDatabaseId(value: DatabaseId, field: string): string {
  if (typeof value === "bigint") {
    if (value > BigInt(0)) return value.toString();
  } else if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value > 0) return String(value);
  } else if (/^[1-9][0-9]*$/.test(value)) {
    return value;
  }

  throw new MessageEnvelopeError(field, "must be a positive integer");
}

function nonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new MessageEnvelopeError(field, "must be a string");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new MessageEnvelopeError(field, "must not be blank");
  }
  return trimmed;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new MessageEnvelopeError(field, "must be a string or null");
  }
  return value;
}

function validateJsonValue(
  value: unknown,
  field: string,
  seen: Set<object>,
  rejectNegativeNumbers: boolean,
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MessageEnvelopeError(field, "must contain only finite numbers");
    }
    if (rejectNegativeNumbers && value < 0) {
      throw new MessageEnvelopeError(field, "must not contain negative numbers");
    }
    return;
  }
  if (typeof value !== "object") {
    throw new MessageEnvelopeError(field, "must contain only JSON values");
  }
  if (seen.has(value)) {
    throw new MessageEnvelopeError(field, "must not contain circular references");
  }

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new MessageEnvelopeError(field, "must contain only JSON objects and arrays");
  }

  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    validateJsonValue(child, `${field}.${key}`, seen, rejectNegativeNumbers);
  }
  seen.delete(value);
}

function jsonObject(
  value: unknown,
  field: string,
  rejectNegativeNumbers = false,
): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MessageEnvelopeError(field, "must be a JSON object");
  }
  validateJsonValue(value, field, new Set(), rejectNegativeNumbers);
  return value as JsonObject;
}

function interval(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (
    !Number.isInteger(resolved) ||
    resolved < MIN_POLL_INTERVAL_MS ||
    resolved > MAX_POLL_INTERVAL_MS
  ) {
    throw new RangeError(
      `${field} must be an integer from ${MIN_POLL_INTERVAL_MS} to ${MAX_POLL_INTERVAL_MS}`,
    );
  }
  return resolved;
}

function messageFromRow(row: QueryResultRow): MessageRow {
  return {
    id: row.id,
    runId: row.run_id,
    ticketId: row.ticket_id,
    sequenceNumber: row.sequence_number,
    sender: row.sender,
    recipient: row.recipient,
    type: row.type,
    payload: row.payload,
    handoffBrief: row.handoff_brief,
    tokenUsage: row.token_usage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The sole producer write path. Passing a PoolClient that is already inside a
 * transaction makes the insert part of that caller transaction. Passing a Pool
 * performs one autocommitted statement. FACT-6's trigger assigns the commit-safe
 * per-run sequence number in either case.
 */
export async function insertMessage(
  database: Queryable,
  envelope: MessageEnvelope,
): Promise<MessageRow> {
  if (!envelope || typeof envelope !== "object") {
    throw new MessageEnvelopeError("message", "must be an object");
  }

  const runId = positiveDatabaseId(envelope.runId, "runId");
  const ticketId =
    envelope.ticketId === undefined || envelope.ticketId === null
      ? null
      : positiveDatabaseId(envelope.ticketId, "ticketId");
  const sender = nonBlankString(envelope.sender, "sender");
  const recipient = nonBlankString(envelope.recipient, "recipient");
  if (!MESSAGE_TYPE_SET.has(envelope.type)) {
    throw new MessageEnvelopeError(
      "type",
      `must be one of: ${MESSAGE_TYPES.join(", ")}`,
    );
  }
  const payload = jsonObject(envelope.payload, "payload");
  const handoffBrief = optionalString(envelope.handoffBrief, "handoffBrief");
  const tokenUsage =
    envelope.tokenUsage === undefined || envelope.tokenUsage === null
      ? null
      : jsonObject(envelope.tokenUsage, "tokenUsage", true);

  const result = await database.query(
    `INSERT INTO messages (
       run_id, ticket_id, sender, recipient, type, payload,
       handoff_brief, token_usage
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      runId,
      ticketId,
      sender,
      recipient,
      envelope.type,
      payload,
      handoffBrief,
      tokenUsage,
    ],
  );
  return messageFromRow(result.rows[0]);
}

async function rollbackAfterFailure(client: PoolClient, cause: unknown): Promise<never> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    throw new AggregateError(
      [cause, rollbackError],
      "message routing failed and its transaction could not confirm rollback",
      { cause },
    );
  }
  throw cause;
}

/**
 * Route at most one message. A transaction-scoped advisory lock serializes
 * routing inside one run without conflicting with producers' foreign-key locks.
 * The handler must perform database routing only and must not end this
 * transaction. Its mutations and the unique consumption receipt commit or roll
 * back together.
 */
export async function consumeNextMessage(
  pool: Pool,
  handler: DatabaseRoutingHandler,
  options: ConsumeOptions,
): Promise<ConsumedMessage | null> {
  const consumerId = nonBlankString(options.consumerId, "consumerId");
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const candidateRuns = await client.query<{ run_id: string }>(
      `SELECT DISTINCT message.run_id
       FROM messages AS message
       WHERE NOT EXISTS (
         SELECT 1
         FROM message_consumptions AS consumption
         WHERE consumption.message_id = message.id
       )
       ORDER BY message.run_id
       LIMIT $1`,
      [CANDIDATE_RUN_LIMIT],
    );

    let message: MessageRow | null = null;
    for (const candidate of candidateRuns.rows) {
      const lock = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_xact_lock(
           hashtextextended(
             'orbitfactory:message-consumer-run:' || $1::text,
             0
           )
         ) AS acquired`,
        [candidate.run_id],
      );
      if (!lock.rows[0].acquired) continue;

      const messageResult = await client.query(
        `SELECT message.*
         FROM messages AS message
         WHERE message.run_id = $1
           AND NOT EXISTS (
             SELECT 1
             FROM message_consumptions AS consumption
             WHERE consumption.message_id = message.id
           )
         ORDER BY message.sequence_number
         FOR UPDATE OF message
         LIMIT 1`,
        [candidate.run_id],
      );
      if (messageResult.rowCount === 1) {
        message = messageFromRow(messageResult.rows[0]);
        break;
      }
    }

    if (!message) {
      await client.query("COMMIT");
      transactionOpen = false;
      return null;
    }

    await handler(client, message);

    const receipt = await client.query<{
      message_id: string;
      consumer_id: string;
      consumed_at: Date;
    }>(
      `INSERT INTO message_consumptions (message_id, consumer_id)
       VALUES ($1, $2)
       RETURNING message_id, consumer_id, consumed_at`,
      [message.id, consumerId],
    );

    await client.query("COMMIT");
    transactionOpen = false;
    return {
      message,
      consumption: {
        messageId: receipt.rows[0].message_id,
        consumerId: receipt.rows[0].consumer_id,
        consumedAt: receipt.rows[0].consumed_at,
      },
    };
  } catch (error) {
    if (transactionOpen) return rollbackAfterFailure(client, error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Sequential bounded polling. Handler errors stop the worker by default; an
 * explicit onError hook may observe the failure and return to authorize retry.
 */
export async function runMessageBusWorker(
  pool: Pool,
  handler: DatabaseRoutingHandler,
  options: RunWorkerOptions,
): Promise<void> {
  const pollIntervalMs = interval(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    "pollIntervalMs",
  );
  const retryIntervalMs = interval(
    options.retryIntervalMs,
    DEFAULT_RETRY_INTERVAL_MS,
    "retryIntervalMs",
  );
  const signal = options.signal;

  while (!signal?.aborted) {
    let consumed: ConsumedMessage | null;
    try {
      consumed = await consumeNextMessage(pool, handler, options);
    } catch (error) {
      if (!options.onError) throw error;
      await options.onError(error);
      if (signal?.aborted) return;
      try {
        await delay(retryIntervalMs, undefined, { signal });
      } catch (delayError) {
        if (signal?.aborted) return;
        throw delayError;
      }
      continue;
    }

    if (consumed) continue;
    try {
      await delay(pollIntervalMs, undefined, { signal });
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    }
  }
}

export function startMessageBusWorker(
  pool: Pool,
  handler: DatabaseRoutingHandler,
  options: Omit<RunWorkerOptions, "signal"> = { consumerId: "engine" },
): MessageBusWorker {
  const controller = new AbortController();
  const done = runMessageBusWorker(pool, handler, {
    ...options,
    signal: controller.signal,
  });

  return {
    done,
    async stop() {
      controller.abort();
      await done;
    },
  };
}
