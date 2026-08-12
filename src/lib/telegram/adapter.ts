import { setTimeout as delay } from "node:timers/promises";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  insertMessage,
  type JsonObject,
  type MessageRow,
} from "../postgres/message-bus.ts";
import {
  WorkflowGraphError,
  parseWorkflowGraph,
  workflowEntryNodeId,
} from "../workflow/graph.ts";
import { collectingChannelSpec } from "../channel-intake.ts";
import { isChannelStatusRequest } from "../channel-reporting.ts";

export interface TelegramInboundUpdate {
  updateId: number;
  messageId: number;
  chat: {
    id: number;
    type: string;
    username?: string;
    title?: string;
  };
  from?: {
    id: number;
    username?: string;
    firstName?: string;
    lastName?: string;
  };
  text?: string;
}

export type TelegramInboundResult =
  | { kind: "ignored" }
  | { kind: "duplicate"; runId: string; messageId: string }
  | { kind: "accepted"; runId: string; messageId: string };

export interface TelegramApi {
  sendMessage(chatId: string, text: string): Promise<{ messageId: number }>;
}

export interface TelegramOutboundWorker {
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

interface BoundEntry extends QueryResultRow {
  agent_id: string;
  workflow_id: string;
  graph: JsonObject;
}

interface ClaimedOutbound extends QueryResultRow {
  id: string;
  payload: JsonObject;
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-blank string`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return value;
  throw new TypeError(`${field} must be a positive integer`);
}

// Telegram group and supergroup chat ids are negative. User, update, and
// message ids remain positive, but reply routing must preserve either chat id.
function chatId(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value !== 0) {
    return String(value);
  }
  if (typeof value === "string" && /^-?[1-9][0-9]*$/.test(value)) return value;
  throw new TypeError(`${field} must be a non-zero integer`);
}

function supportedInbound(update: TelegramInboundUpdate): update is TelegramInboundUpdate & { text: string } {
  return typeof update?.text === "string" && update.text.trim() !== "";
}

function inboundPayload(update: TelegramInboundUpdate & { text: string }): JsonObject {
  return {
    provider: "telegram",
    updateId: positiveInteger(update.updateId, "updateId"),
    messageId: positiveInteger(update.messageId, "messageId"),
    chat: {
      id: chatId(update.chat?.id, "chat.id"),
      type: nonBlank(update.chat?.type, "chat.type"),
      ...(update.chat.username ? { username: update.chat.username } : {}),
      ...(update.chat.title ? { title: update.chat.title } : {}),
    },
    ...(update.from
      ? {
          from: {
            id: positiveInteger(update.from.id, "from.id"),
            ...(update.from.username ? { username: update.from.username } : {}),
            ...(update.from.firstName ? { firstName: update.from.firstName } : {}),
            ...(update.from.lastName ? { lastName: update.from.lastName } : {}),
          },
        }
      : {}),
    text: update.text.trim(),
    ...(isChannelStatusRequest(update.text) ? { channelRequest: "status" } : {}),
  };
}

async function withTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
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

async function boundEntry(transaction: PoolClient): Promise<BoundEntry> {
  const result = await transaction.query<BoundEntry>(
    `SELECT agent.id AS agent_id, workflow.id AS workflow_id, workflow.graph
     FROM agents AS agent
     JOIN workflows AS workflow
       ON workflow.name = agent.channel_binding ->> 'workflow'
     WHERE agent.channel_binding ->> 'provider' = 'telegram'
     ORDER BY agent.id
     FOR KEY SHARE OF agent, workflow`,
  );
  if (result.rowCount !== 1) {
    throw new WorkflowGraphError("exactly one Telegram-bound agent and workflow are required");
  }
  const entry = result.rows[0]!;
  const graph = parseWorkflowGraph(entry.graph);
  const node = graph.nodes.find((candidate) => candidate.id === workflowEntryNodeId(graph))!;
  if (node.agentId.toString() !== entry.agent_id || node.config.channelBinding !== true) {
    throw new WorkflowGraphError("Telegram-bound workflow entry must bind the configured agent");
  }
  return entry;
}

/**
 * Persists a text update before the engine sees it. PostgreSQL serializes one
 * Telegram update id, so a long-poll retry returns the original durable row.
 */
export async function ingestTelegramInbound(
  pool: Pool,
  update: TelegramInboundUpdate,
): Promise<TelegramInboundResult> {
  if (!supportedInbound(update)) return { kind: "ignored" };
  const payload = inboundPayload(update);
  return withTransaction(pool, async (transaction) => {
    const updateId = payload.updateId as string;
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`orbitflow:telegram-update:${updateId}`],
    );
    const existing = await transaction.query<{ run_id: string; message_id: string }>(
      "SELECT run_id, message_id FROM telegram_inbound_updates WHERE update_id = $1",
      [updateId],
    );
    if (existing.rows[0]) {
      return { kind: "duplicate", runId: existing.rows[0].run_id, messageId: existing.rows[0].message_id };
    }

    const target = await boundEntry(transaction);
    const chat = payload.chat as JsonObject;
    const text = payload.text as string;
    const conversationKey = chat.id as string;
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`orbitflow:channel-intake:telegram:${conversationKey}:${target.workflow_id}`],
    );
    const collecting = await transaction.query<{ run_id: string }>(
      `SELECT run_id
       FROM channel_intakes
       WHERE provider = 'telegram' AND conversation_key = $1
         AND workflow_id = $2 AND status = 'collecting'
       FOR UPDATE`,
      [conversationKey, target.workflow_id],
    );
    const active = collecting.rows[0]
      ? null
      : await transaction.query<{ run_id: string }>(
        `SELECT intake.run_id
         FROM channel_intakes AS intake
         JOIN workflow_runs AS run ON run.id = intake.run_id
         WHERE intake.provider = 'telegram' AND intake.conversation_key = $1
           AND intake.workflow_id = $2 AND intake.status = 'ready'
           AND run.status IN ('running', 'paused')
         ORDER BY intake.updated_at DESC, intake.run_id DESC
         FOR KEY SHARE OF intake, run
         LIMIT 1`,
        [conversationKey, target.workflow_id],
      );
    const existingRunId = collecting.rows[0]?.run_id ?? active?.rows[0]?.run_id;
    const run = await transaction.query<{ id: string }>(
      existingRunId
        ? "SELECT $1::bigint AS id"
        : `INSERT INTO workflow_runs (workflow_id, trigger_type, spec)
           VALUES ($1, 'channel', $2)
           RETURNING id`,
      existingRunId
        ? [existingRunId]
        : [target.workflow_id, collectingChannelSpec({
            provider: "telegram",
            chat,
            ...(payload.from ? { from: payload.from as JsonObject } : {}),
            messageId: payload.messageId as string,
            updateId,
            text,
          })],
    );
    const runId = run.rows[0]!.id;
    const message = await insertMessage(transaction, {
      runId,
      sender: `telegram:chat:${chat.id as string}`,
      recipient: `agent:${target.agent_id}`,
      type: "channel_inbound",
      payload,
      handoffBrief: text,
    });
    await transaction.query(
      `INSERT INTO telegram_inbound_updates (update_id, run_id, message_id)
       VALUES ($1, $2, $3)`,
      [updateId, runId, message.id],
    );
    if (collecting.rows[0]) {
      await transaction.query(
        `UPDATE channel_intakes
         SET last_inbound_message_id = $2, last_question = NULL,
             updated_at = clock_timestamp()
         WHERE run_id = $1 AND status = 'collecting'`,
        [runId, message.id],
      );
      await transaction.query(
        `UPDATE workflow_runs
         SET spec = jsonb_set(
           spec,
           '{channelContext,inboundMessages}',
           COALESCE(spec #> '{channelContext,inboundMessages}', '[]'::jsonb) || $2::jsonb
         ), updated_at = clock_timestamp()
         WHERE id = $1`,
        [runId, JSON.stringify([{ messageId: payload.messageId, updateId, text }])],
      );
    } else if (!existingRunId) {
      await transaction.query(
        `INSERT INTO channel_intakes (
           run_id, workflow_id, provider, conversation_key, last_inbound_message_id
         ) VALUES ($1, $2, 'telegram', $3, $4)`,
        [runId, target.workflow_id, conversationKey, message.id],
      );
    }
    return { kind: "accepted", runId, messageId: message.id };
  });
}

function outboundPayload(payload: JsonObject): { chatId: string; text: string } {
  const provider = payload.provider;
  if (provider !== "telegram") throw new TypeError("channel_outbound provider must be telegram");
  return {
    chatId: chatId(payload.chatId, "channel_outbound chatId"),
    text: nonBlank(payload.text, "channel_outbound text"),
  };
}

async function claimNextOutbound(pool: Pool): Promise<ClaimedOutbound | null> {
  return withTransaction(pool, async (transaction) => {
    const result = await transaction.query<ClaimedOutbound>(
      `WITH candidate AS (
         SELECT message.id, message.payload
         FROM messages AS message
         LEFT JOIN telegram_outbound_deliveries AS delivery ON delivery.message_id = message.id
         WHERE message.type = 'channel_outbound'
           AND delivery.message_id IS NULL
         ORDER BY message.id
         FOR UPDATE OF message SKIP LOCKED
         LIMIT 1
       )
       INSERT INTO telegram_outbound_deliveries (message_id, status)
       SELECT id, 'sending'::telegram_outbound_delivery_status FROM candidate
       ON CONFLICT DO NOTHING
       RETURNING message_id AS id, (SELECT payload FROM candidate) AS payload`,
    );
    return result.rows[0] ?? null;
  });
}

async function markOutboundSent(pool: Pool, messageId: string, telegramMessageId: number): Promise<void> {
  await pool.query(
    `UPDATE telegram_outbound_deliveries
     SET status = 'sent', telegram_message_id = $2, sent_at = clock_timestamp()
     WHERE message_id = $1 AND status = 'sending'`,
    [messageId, positiveInteger(telegramMessageId, "telegram message id")],
  );
}

async function markOutboundIndeterminate(pool: Pool, messageId: string, reason: unknown): Promise<void> {
  const detail = (reason instanceof Error ? reason.message : String(reason)).trim().slice(0, 500)
    || "Telegram delivery result is unknown";
  await pool.query(
    `UPDATE telegram_outbound_deliveries
     SET status = 'indeterminate', failure_reason = $2
     WHERE message_id = $1 AND status = 'sending'`,
    [messageId, detail],
  );
}

/** Send one durable outbound message. A post-claim failure is not retried: Telegram has no idempotency key. */
export async function deliverNextTelegramOutbound(pool: Pool, api: TelegramApi): Promise<boolean> {
  const claimed = await claimNextOutbound(pool);
  if (!claimed) return false;
  try {
    const payload = outboundPayload(claimed.payload);
    const response = await api.sendMessage(payload.chatId, payload.text);
    await markOutboundSent(pool, claimed.id, response.messageId);
  } catch (error) {
    await markOutboundIndeterminate(pool, claimed.id, error);
    throw error;
  }
  return true;
}

/** A previous process may have sent a claimed message before dying. Never guess and resend it. */
export async function quarantineInterruptedTelegramDeliveries(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE telegram_outbound_deliveries
     SET status = 'indeterminate', failure_reason = 'Telegram process stopped before delivery result was recorded'
     WHERE status = 'sending'`,
  );
}

export function startTelegramOutboundWorker(
  pool: Pool,
  api: TelegramApi,
  pollIntervalMs = 250,
): TelegramOutboundWorker {
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60_000) {
    throw new RangeError("pollIntervalMs must be an integer from 10 to 60000");
  }
  const controller = new AbortController();
  const done = (async () => {
    await quarantineInterruptedTelegramDeliveries(pool);
    while (!controller.signal.aborted) {
      try {
        if (await deliverNextTelegramOutbound(pool, api)) continue;
        await delay(pollIntervalMs, undefined, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) return;
        throw error;
      }
    }
  })();
  return {
    done,
    async stop() {
      controller.abort();
      await done;
    },
  };
}

/** Used by engine routing to validate the durable event before an entry wake. */
export function telegramInboundForEngine(message: MessageRow): JsonObject {
  if (message.type !== "channel_inbound") throw new TypeError("message must be channel_inbound");
  const payload = message.payload;
  if (payload.provider !== "telegram") throw new TypeError("channel inbound provider must be telegram");
  nonBlank(payload.text, "channel inbound text");
  const chat = payload.chat;
  if (chat === null || typeof chat !== "object" || Array.isArray(chat)) {
    throw new TypeError("channel inbound chat must be an object");
  }
  chatId(chat.id, "channel inbound chat.id");
  nonBlank(chat.type, "channel inbound chat.type");
  return payload;
}
