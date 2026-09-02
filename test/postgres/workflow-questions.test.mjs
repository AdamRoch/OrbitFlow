import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import { consumeNextMessage, insertMessage } from "../../src/lib/postgres/message-bus.ts";
import {
  routeWorkflowMessage, createWorkflowRun, dispatchNextWorkflowNode,
  getWorkflowRun, startWorkflowRun,
} from "../../src/lib/postgres/workflow-engine.ts";
import { answerWorkflowQuestionFromUi } from "../../src/lib/postgres/workflow-questions.ts";
import {
  deliverNextTelegramOutbound,
  ingestTelegramInbound,
  telegramInboundFromGrammyUpdate,
} from "../../src/lib/telegram/adapter.ts";

const { Client, Pool } = pg;
const migrationDirectory = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

class Runtime {
  calls = [];
  async startSession(request) {
    this.calls.push(request);
    return { kind: "started", sessionId: `fact24-${request.dispatchId}` };
  }
  async reconcileSession(request) {
    this.calls.push(request);
    return { kind: "started", sessionId: `fact24-${request.dispatchId}` };
  }
}

function grammyTextUpdate({ updateId, messageId, chatId, text, replyToMessageId }) {
  const chat = { id: chatId, type: "supergroup", title: "Factory operators" };
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_786_666_000,
      chat,
      from: {
        id: 37001,
        is_bot: false,
        first_name: "Adam",
        username: "adam",
        language_code: "en",
      },
      text,
      ...(replyToMessageId === undefined ? {} : {
        reply_to_message: {
          message_id: replyToMessageId,
          date: 1_786_665_900,
          chat,
          from: { id: 37002, is_bot: true, first_name: "OrbitFlow" },
          text: "Which implementation constraint should I use?",
        },
      }),
    },
  };
}

test("FACT-24 durable question, escalation, and approval mechanism", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl);
  const client = new Client({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  await client.connect();
  try {
    assert.equal((await client.query("SELECT current_database() AS name")).rows[0].name, process.env.ORBITFACTORY_FACT24_PROOF_DATABASE);
    const migration = await migratePostgres({ databaseUrl, log: () => {} });
    const files = (await readdir(migrationDirectory)).filter((name) => /^\d{4}-[a-z0-9-]+\.sql$/.test(name)).sort();
    assert.deepEqual(migration.applied, files);
    await client.query("UPDATE agents SET channel_binding = NULL WHERE channel_binding IS NOT NULL");

    const agents = {};
    for (const name of ["worker", "answerer", "approver"]) {
      agents[name] = (await client.query(
        "INSERT INTO agents (name, role, system_prompt, model) VALUES ($1, $2, $3, $4) RETURNING id",
        [`FACT-24 ${name}`, name, `${name} prompt`, `mock/${name}`],
      )).rows[0].id;
    }
    const projectId = (await client.query("INSERT INTO projects (key, name) VALUES ('QA', 'FACT-24 proof') RETURNING id")).rows[0].id;
    let workflowNumber = 0;
    let ticketNumber = 0;

    async function createRun(graph, { tickets = 0, triggerType = "ui", spec = { objective: "FACT-24 proof" } } = {}) {
      workflowNumber += 1;
      const workflowId = (await client.query(
        "INSERT INTO workflows (name, description, graph) VALUES ($1, 'FACT-24 proof', $2) RETURNING id",
        [`FACT-24 workflow ${workflowNumber}`, graph],
      )).rows[0].id;
      const created = await createWorkflowRun(pool, { workflowId, triggerType, spec });
      const ticketIds = [];
      for (let index = 0; index < tickets; index += 1) {
        ticketNumber += 1;
        ticketIds.push((await client.query(
          `INSERT INTO tickets (number, identifier, project_id, run_id, title, status, priority)
           VALUES ($1, $2, $3, $4, $5, 'todo', $6) RETURNING id`,
          [ticketNumber, `QA-${ticketNumber}`, projectId, created.id, `Question proof ${ticketNumber}`, 4 - index],
        )).rows[0].id);
      }
      return { run: await startWorkflowRun(pool, created.id), ticketIds };
    }

    async function consumeThrough(messageId, database = pool) {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const consumed = await consumeNextMessage(database, routeWorkflowMessage, { consumerId: `fact24-${messageId}` });
        if (consumed?.message.id === messageId) return;
      }
      assert.fail(`message ${messageId} was not consumed`);
    }

    async function dispatch(runId, ticketId, answering = false) {
      const result = await client.query(
        `SELECT * FROM workflow_dispatches WHERE run_id = $1
           AND ticket_id IS NOT DISTINCT FROM $2::bigint
           AND ($3::boolean = (answering_question_id IS NOT NULL))
         ORDER BY id DESC LIMIT 1`,
        [runId, ticketId, answering],
      );
      assert.ok(result.rows[0]);
      return result.rows[0];
    }

    async function activate(runId, ticketId, runtime, workerId) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const current = await client.query(
          `SELECT * FROM workflow_dispatches WHERE run_id = $1
             AND ticket_id IS NOT DISTINCT FROM $2::bigint
             AND answering_question_id IS NULL AND status = 'active'
           ORDER BY id DESC LIMIT 1`,
          [runId, ticketId],
        );
        if (current.rows[0]) return current.rows[0];
        await dispatchNextWorkflowNode(pool, runtime, { workerId });
      }
      assert.fail(`dispatch for run ${runId} ticket ${ticketId} did not activate`);
    }

    async function output(row, value) {
      const message = await insertMessage(pool, {
        runId: row.run_id, ticketId: row.ticket_id, sender: `agent:${row.agent_id}`,
        recipient: "workflow-engine", type: "output",
        payload: { dispatchId: row.id, dispatchGeneration: row.runtime_generation,
          sessionId: row.runtime_session_id, output: value }, handoffBrief: "node complete",
      });
      await consumeThrough(message.id);
      return message;
    }

    await test("pauses one fan-out thread, wakes only an allowed agent, and resumes once after restart", async () => {
      const graph = {
        nodes: [
          { id: "worker", agentId: agents.worker, config: { entry: true, fanOut: { maxConcurrency: 2 }, questionEscalation: { target: "agent", agentId: agents.answerer } } },
          { id: "answer", agentId: agents.answerer, config: { may_answer_questions: true } },
        ], edges: [],
      };
      const { run, ticketIds } = await createRun(graph, { tickets: 3 });
      const runtime = new Runtime();
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "worker-a" });
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "worker-b" });
      await dispatch(run.id, ticketIds[0]);
      const sibling = await dispatch(run.id, ticketIds[1]);
      const question = await insertMessage(pool, {
        runId: run.id, ticketId: ticketIds[0], sender: `agent:${agents.worker}`,
        recipient: "workflow-engine", type: "question", payload: { question: "Which API shape should I use?" },
        handoffBrief: "Which API shape should I use?",
      });
      await consumeThrough(question.id);
      assert.equal((await client.query("SELECT status FROM workflow_thread_states WHERE run_id = $1 AND ticket_id = $2", [run.id, ticketIds[0]])).rows[0].status, "paused");
      await output(sibling, { done: true });
      assert.equal((await client.query("SELECT count(*)::int AS count FROM workflow_dispatches WHERE run_id = $1 AND ticket_id = $2", [run.id, ticketIds[2]])).rows[0].count, 1, "sibling progress releases fan-out capacity");

      const questionRow = (await client.query("SELECT * FROM workflow_questions WHERE question_message_id = $1", [question.id])).rows[0];
      const answerWake = await dispatch(run.id, ticketIds[0], true);
      assert.equal(answerWake.agent_id, agents.answerer);
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "answerer" });
      assert.equal(runtime.calls.at(-1).input.questionContext.questionId, questionRow.id);
      const answerWakeActive = await dispatch(run.id, ticketIds[0], true);
      const spoofed = await insertMessage(pool, {
        runId: run.id, ticketId: ticketIds[0], sender: `agent:${agents.worker}`,
        recipient: "workflow-engine", type: "answer",
        payload: { questionId: questionRow.id, answer: "spoofed" }, handoffBrief: "spoofed",
      });
      await consumeThrough(spoofed.id);
      assert.equal((await client.query("SELECT status FROM workflow_questions WHERE id = $1", [questionRow.id])).rows[0].status, "pending", "a rejected sender cannot partially answer the question");
      const answer = await insertMessage(pool, {
        runId: run.id, ticketId: ticketIds[0], sender: `agent:${agents.answerer}`,
        recipient: "workflow-engine", type: "answer",
        payload: { questionId: questionRow.id, answer: "Use the existing DTO.", answeringDispatchId: answerWakeActive.id,
          dispatchGeneration: answerWakeActive.runtime_generation, sessionId: answerWakeActive.runtime_session_id },
        handoffBrief: "Use the existing DTO.",
      });
      const restartedPool = new Pool({ connectionString: databaseUrl, max: 2 });
      await consumeThrough(answer.id, restartedPool);
      await restartedPool.end();
      const duplicate = await insertMessage(pool, {
        runId: run.id, ticketId: ticketIds[0], sender: `agent:${agents.answerer}`,
        recipient: "workflow-engine", type: "answer", payload: { questionId: questionRow.id, answer: "Use the existing DTO." },
        handoffBrief: "duplicate answer",
      });
      await consumeThrough(duplicate.id);
      assert.equal((await client.query("SELECT count(*)::int AS count FROM workflow_dispatches WHERE run_id = $1 AND ticket_id = $2 AND answering_question_id IS NULL", [run.id, ticketIds[0]])).rows[0].count, 2, "duplicate answer cannot create a second continuation");
    });

    await test("routes Telegram replies and UI answers back to the exact ticket thread", async () => {
      for (const route of ["human-via-channel", "human-via-UI"]) {
        const graph = { nodes: [{ id: "worker", agentId: agents.worker, config: { entry: true, fanOut: { maxConcurrency: 1 }, questionEscalation: { target: route } } }], edges: [] };
        const chatId = "-1002400";
        const { run, ticketIds } = await createRun(graph, { tickets: 1, spec: { objective: route, channelContext: { provider: "telegram", chat: { id: chatId } } } });
        const runtime = new Runtime();
        const worker = await activate(run.id, ticketIds[0], runtime, route);
        const question = await insertMessage(pool, { runId: run.id, ticketId: ticketIds[0], sender: `agent:${agents.worker}`, recipient: "workflow-engine", type: "question", payload: { question: `Question for ${route}` }, handoffBrief: `Question for ${route}` });
        await consumeThrough(question.id);
        const pending = (await client.query("SELECT * FROM workflow_questions WHERE question_message_id = $1", [question.id])).rows[0];
        if (route === "human-via-channel") {
          await deliverNextTelegramOutbound(pool, { async sendMessage(sentChatId) { assert.equal(sentChatId, chatId); return { messageId: 82400 }; } });
          const accepted = await ingestTelegramInbound(pool, { updateId: 24001, messageId: 24002, chat: { id: Number(chatId), type: "supergroup" }, text: "Telegram answer", replyToMessageId: 82400 });
          assert.equal(accepted.runId, run.id);
          await consumeThrough(accepted.messageId);
        } else {
          const accepted = await answerWorkflowQuestionFromUi(pool, pending.id, { answer: "UI answer" });
          await consumeThrough(accepted.message.id);
        }
        const continuation = await dispatch(run.id, ticketIds[0]);
        assert.notEqual(continuation.id, worker.id);
        assert.equal(continuation.source_message_id, pending.answer_message_id ?? (await client.query("SELECT answer_message_id FROM workflow_questions WHERE id = $1", [pending.id])).rows[0].answer_message_id);
      }
    });

    await test("correlates realistic Telegram replies durably and fails safe across duplicates, stale replies, mismatches, retries, and restart", async () => {
      const channelAgent = (await client.query(
        `INSERT INTO agents (name, role, system_prompt, model, channel_binding)
         VALUES ('FACT-37 channel entry', 'orchestrator', 'ordinary input', 'mock/channel',
                 '{"provider":"telegram","workflow":"FACT-37 channel fallback"}'::jsonb)
         RETURNING id`,
      )).rows[0].id;
      await client.query(
        `INSERT INTO workflows (name, description, graph)
         VALUES ('FACT-37 channel fallback', 'Ordinary Telegram input', $1)`,
        [{ nodes: [{ id: "entry", agentId: channelAgent, config: { entry: true, channelBinding: true } }], edges: [] }],
      );

      async function openQuestion(chatId, telegramMessageId) {
        const graph = {
          nodes: [{
            id: "worker",
            agentId: agents.worker,
            config: {
              entry: true,
              fanOut: { maxConcurrency: 1 },
              questionEscalation: { target: "human-via-channel" },
            },
          }],
          edges: [],
        };
        const { run, ticketIds } = await createRun(graph, {
          tickets: 1,
          spec: {
            objective: `FACT-37 correlation ${telegramMessageId}`,
            channelContext: { provider: "telegram", chat: { id: String(chatId), type: "supergroup" } },
          },
        });
        const runtime = new Runtime();
        await activate(run.id, ticketIds[0], runtime, `fact37-${telegramMessageId}`);
        const questionMessage = await insertMessage(pool, {
          runId: run.id,
          ticketId: ticketIds[0],
          sender: `agent:${agents.worker}`,
          recipient: "workflow-engine",
          type: "question",
          payload: { question: `Question sent as ${telegramMessageId}` },
          handoffBrief: `Question sent as ${telegramMessageId}`,
        });
        await consumeThrough(questionMessage.id);
        const question = (await client.query(
          "SELECT * FROM workflow_questions WHERE question_message_id = $1",
          [questionMessage.id],
        )).rows[0];
        assert.equal(await deliverNextTelegramOutbound(pool, {
          async sendMessage(sentChatId) {
            assert.equal(sentChatId, String(chatId));
            return { messageId: telegramMessageId };
          },
        }), true);
        return { run, ticketId: ticketIds[0], question };
      }

      const first = await openQuestion(-1003700, 83700);
      const second = await openQuestion(-1003700, 83701);
      const otherChat = await openQuestion(-1003701, 83702);

      const realistic = grammyTextUpdate({
        updateId: 37001,
        messageId: 47001,
        chatId: -1003700,
        text: "Use the durable existing contract.",
        replyToMessageId: 83700,
      });
      const normalized = telegramInboundFromGrammyUpdate(realistic);
      assert.equal(normalized.replyToMessageId, realistic.message.reply_to_message.message_id);
      assert.deepEqual(normalized.from, { id: 37001, username: "adam", firstName: "Adam" });

      const accepted = await ingestTelegramInbound(pool, normalized);
      assert.equal(accepted.kind, "accepted");
      assert.equal(accepted.runId, first.run.id);
      const answerRow = (await client.query(
        "SELECT run_id, ticket_id, type, payload FROM messages WHERE id = $1",
        [accepted.messageId],
      )).rows[0];
      assert.equal(answerRow.run_id, first.run.id);
      assert.equal(answerRow.ticket_id, first.ticketId);
      assert.equal(answerRow.type, "answer");
      assert.equal(answerRow.payload.questionId, first.question.id);
      assert.equal(answerRow.payload.replyToMessageId, "83700");

      const retry = await ingestTelegramInbound(pool, telegramInboundFromGrammyUpdate(realistic));
      assert.deepEqual(retry, { kind: "duplicate", runId: accepted.runId, messageId: accepted.messageId });

      const wrongChat = await ingestTelegramInbound(pool, telegramInboundFromGrammyUpdate(grammyTextUpdate({
        updateId: 37002,
        messageId: 47002,
        chatId: -1003701,
        text: "This must not answer the first chat.",
        replyToMessageId: 83700,
      })));
      const unrelated = await ingestTelegramInbound(pool, telegramInboundFromGrammyUpdate(grammyTextUpdate({
        updateId: 37003,
        messageId: 47003,
        chatId: -1003700,
        text: "Start an ordinary channel request.",
      })));
      for (const result of [wrongChat, unrelated]) {
        const row = (await client.query("SELECT type, recipient FROM messages WHERE id = $1", [result.messageId])).rows[0];
        assert.equal(row.type, "channel_inbound");
        assert.equal(row.recipient, `agent:${channelAgent}`);
      }
      assert.deepEqual(
        (await client.query(
          "SELECT id, status FROM workflow_questions WHERE id = ANY($1::bigint[]) ORDER BY id",
          [[first.question.id, second.question.id, otherChat.question.id]],
        )).rows.map((row) => row.status),
        ["pending", "pending", "pending"],
        "mismatched and unrelated updates cannot answer any pending question",
      );

      const restartedPool = new Pool({ connectionString: databaseUrl, max: 2 });
      await consumeThrough(accepted.messageId, restartedPool);
      await restartedPool.end();
      const answeredFirst = (await client.query(
        "SELECT status, answer_message_id FROM workflow_questions WHERE id = $1",
        [first.question.id],
      )).rows[0];
      assert.deepEqual(answeredFirst, { status: "answered", answer_message_id: accepted.messageId });
      assert.equal((await dispatch(first.run.id, first.ticketId)).source_message_id, accepted.messageId);

      const stale = await ingestTelegramInbound(pool, telegramInboundFromGrammyUpdate(grammyTextUpdate({
        updateId: 37004,
        messageId: 47004,
        chatId: -1003700,
        text: "A late second answer.",
        replyToMessageId: 83700,
      })));
      const staleRow = (await client.query("SELECT type FROM messages WHERE id = $1", [stale.messageId])).rows[0];
      assert.equal(staleRow.type, "channel_inbound");
      assert.deepEqual(
        (await client.query("SELECT status, answer_message_id FROM workflow_questions WHERE id = $1", [first.question.id])).rows[0],
        answeredFirst,
        "a stale reply cannot replace the durable answer",
      );

      const secondAnswer = await ingestTelegramInbound(pool, telegramInboundFromGrammyUpdate(grammyTextUpdate({
        updateId: 37005,
        messageId: 47005,
        chatId: -1003700,
        text: "The exact second answer.",
        replyToMessageId: 83701,
      })));
      await consumeThrough(secondAnswer.messageId);
      assert.equal(
        (await client.query("SELECT status FROM workflow_questions WHERE id = $1", [second.question.id])).rows[0].status,
        "answered",
      );
      assert.equal(
        (await client.query("SELECT status FROM workflow_questions WHERE id = $1", [otherChat.question.id])).rows[0].status,
        "pending",
        "answering one exact message cannot answer another chat's pending question",
      );
    });

    await test("uses the same durable question record for before and after approvals", async () => {
      const graph = { nodes: [{ id: "gated", agentId: agents.worker, config: { entry: true, questionEscalation: { target: "human-via-UI" }, approvalGates: { pauseBefore: true, pauseAfter: true } } }], edges: [] };
      const { run } = await createRun(graph);
      let pending = (await client.query("SELECT * FROM workflow_questions WHERE run_id = $1 AND boundary = 'before'", [run.id])).rows[0];
      const rejected = await answerWorkflowQuestionFromUi(pool, pending.id, { answer: "No", approved: false });
      await consumeThrough(rejected.message.id);
      assert.equal((await client.query("SELECT status FROM workflow_questions WHERE id = $1", [pending.id])).rows[0].status, "pending");
      const approved = await answerWorkflowQuestionFromUi(pool, pending.id, { answer: "Approved", approved: true });
      await consumeThrough(approved.message.id);
      const runtime = new Runtime();
      await output(await activate(run.id, null, runtime, "gated"), { artifact: "safe" });
      pending = (await client.query("SELECT * FROM workflow_questions WHERE run_id = $1 AND boundary = 'after'", [run.id])).rows[0];
      assert.equal((await getWorkflowRun(pool, run.id)).status, "running");
      const after = await answerWorkflowQuestionFromUi(pool, pending.id, { answer: "Approved", approved: true });
      await consumeThrough(after.message.id);
      assert.equal((await getWorkflowRun(pool, run.id)).status, "completed");
      const trail = await client.query("SELECT type, ticket_id FROM messages WHERE run_id = $1 AND type IN ('question','answer') ORDER BY sequence_number", [run.id]);
      assert.deepEqual(trail.rows.map((row) => row.type), ["question", "answer", "answer", "question", "answer"]);
    });
  } finally {
    await pool.end();
    await client.end();
  }
});
