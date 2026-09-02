import type { Pool, PoolClient, QueryResultRow } from "pg";
import { insertMessage, inTransaction, messageFromRow, positiveId, type DatabaseId, type MessageRow } from "./message-bus.ts";

export type QuestionRoute = "agent" | "human-via-channel" | "human-via-UI";
export type QuestionBoundary = "worker" | "before" | "after";

export interface WorkflowQuestionRecord {
  id: string;
  runId: string;
  ticketId: string | null;
  originatingDispatchId: string;
  questionMessageId: string;
  answerMessageId: string | null;
  kind: "question" | "approval";
  boundary: QuestionBoundary;
  route: QuestionRoute;
  targetAgentId: string | null;
  questionText: string;
  status: "pending" | "answered";
  createdAt: Date;
  answeredAt: Date | null;
}

export function boundedAnswer(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError("answer must be a non-blank string");
  if (value.trim().length > 12_000) throw new TypeError("answer exceeds 12000 characters");
  return value.trim();
}

function fromRow(row: QueryResultRow): WorkflowQuestionRecord {
  return {
    id: row.id, runId: row.run_id, ticketId: row.ticket_id,
    originatingDispatchId: row.originating_dispatch_id,
    questionMessageId: row.question_message_id, answerMessageId: row.answer_message_id,
    kind: row.kind, boundary: row.boundary, route: row.route,
    targetAgentId: row.target_agent_id, questionText: row.question_text,
    status: row.status, createdAt: row.created_at, answeredAt: row.answered_at,
  };
}

/** UI answers enter the same bus route as Telegram and agent answers. */
export async function answerWorkflowQuestionFromUi(
  pool: Pool,
  questionIdValue: DatabaseId,
  input: { answer: string; approved?: boolean },
): Promise<{ question: WorkflowQuestionRecord; message: MessageRow; replayed: boolean }> {
  const questionId = positiveId(questionIdValue, "questionId");
  const answer = boundedAnswer(input.answer);
  return inTransaction(pool, async (client) => {
    const result = await client.query(
      "SELECT * FROM workflow_questions WHERE id = $1 FOR UPDATE",
      [questionId],
    );
    const row = result.rows[0];
    if (!row) throw new TypeError(`workflow question ${questionId} not found`);
    if (row.route !== "human-via-UI") throw new TypeError("workflow question is not routed to the UI");
    if (row.status === "answered") {
      const existing = await client.query("SELECT * FROM messages WHERE id = $1", [row.answer_message_id]);
      return { question: fromRow(row), message: messageFromRow(existing.rows[0]), replayed: true };
    }
    const message = await insertMessage(client, {
      runId: row.run_id,
      ticketId: row.ticket_id,
      sender: "human:ui",
      recipient: "workflow-engine",
      type: "answer",
      payload: { questionId, answer, ...(input.approved === undefined ? {} : { approved: input.approved }) },
      handoffBrief: answer,
    });
    return { question: fromRow(row), message, replayed: false };
  });
}

/** Resolve an explicit Telegram reply to the durable question whose outbound message it replies to. */
export async function telegramQuestionForReply(
  transaction: PoolClient,
  chatId: string,
  replyToTelegramMessageId: string,
): Promise<QueryResultRow | null> {
  const result = await transaction.query(
    `SELECT question.*
     FROM workflow_questions AS question
     JOIN messages AS outbound ON outbound.id = question.outbound_message_id
     JOIN telegram_outbound_deliveries AS delivery ON delivery.message_id = outbound.id
     WHERE question.status = 'pending' AND question.route = 'human-via-channel'
       AND outbound.payload ->> 'chatId' = $1
       AND delivery.status = 'sent' AND delivery.telegram_message_id = $2
     FOR UPDATE OF question`,
    [chatId, replyToTelegramMessageId],
  );
  return result.rows[0] ?? null;
}

/** Resolve an unthreaded Telegram message only when its chat has one unambiguous active question. */
export async function uniquePendingTelegramQuestion(
  transaction: PoolClient,
  chatId: string,
): Promise<QueryResultRow | null> {
  const result = await transaction.query(
    `SELECT question.*
     FROM workflow_questions AS question
     JOIN workflow_runs AS run ON run.id = question.run_id
     JOIN messages AS outbound ON outbound.id = question.outbound_message_id
     JOIN telegram_outbound_deliveries AS delivery ON delivery.message_id = outbound.id
     WHERE question.status = 'pending' AND question.route = 'human-via-channel'
       AND run.status IN ('running', 'paused')
       AND outbound.payload ->> 'chatId' = $1
       AND delivery.status = 'sent'
     ORDER BY question.created_at, question.id
     LIMIT 2
     FOR UPDATE OF question`,
    [chatId],
  );
  return result.rowCount === 1 ? result.rows[0]! : null;
}
