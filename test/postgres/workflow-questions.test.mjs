import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import { insertMessage } from "../../src/lib/postgres/message-bus.ts";
import {
  consumeNextWorkflowMessage, createWorkflowRun, dispatchNextWorkflowNode,
  getWorkflowRun, startWorkflowRun,
} from "../../src/lib/postgres/workflow-engine.ts";
import { answerWorkflowQuestionFromUi } from "../../src/lib/postgres/workflow-questions.ts";
import { deliverNextTelegramOutbound, ingestTelegramInbound } from "../../src/lib/telegram/adapter.ts";

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
        const consumed = await consumeNextWorkflowMessage(database, { consumerId: `fact24-${messageId}` });
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
