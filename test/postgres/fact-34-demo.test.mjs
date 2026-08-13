import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import { dispatchPlatformTool } from "../../src/lib/platform-tools/dispatch.ts";
import {
  createWorkflowRun,
  getWorkflowRun,
  startWorkflowEngine,
  startWorkflowRun,
} from "../../src/lib/postgres/workflow-engine.ts";
import { deliverNextTelegramOutbound, ingestTelegramInbound } from "../../src/lib/telegram/adapter.ts";
import { OpenClawEngineAdapter } from "../../src/lib/runtime/engine-adapter.ts";

const { Client, Pool } = pg;

async function until(description, action, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await action();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${description}`);
}

test("FACT-34 real-output question and honest rejection contract", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl);
  const client = new Client({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  await client.connect();

  try {
    assert.equal(
      (await client.query("SELECT current_database() AS name")).rows[0].name,
      process.env.ORBITFACTORY_FACT34_PROOF_DATABASE,
    );
    await migratePostgres({ databaseUrl, log: () => {} });

    const seeded = await client.query(
      `SELECT workflow.graph,
              implementer.system_prompt AS implementer_prompt,
              tester.system_prompt AS tester_prompt
       FROM workflows AS workflow
       JOIN agents AS implementer ON implementer.name = 'Factory Implementer'
       JOIN agents AS tester ON tester.name = 'Factory Tester'
       WHERE workflow.name = 'Software Factory' AND workflow.is_template = true`,
    );
    const seededGraph = seeded.rows[0].graph;
    const seededImplement = seededGraph.nodes.find((node) => node.id === "implement");
    const seededReject = seededGraph.edges.find((edge) => edge.source === "test" && edge.target === "implement");
    assert.deepEqual(seededImplement.config.questionEscalation, { target: "human-via-channel" });
    assert.deepEqual(seededReject.condition.path, ["artifact", "verdict"]);
    assert.match(seeded.rows[0].implementer_prompt, /exactly one event shaped/);
    assert.match(seeded.rows[0].tester_prompt, /update the ticket to todo/);

    const agents = {};
    for (const role of ["implement", "test", "report"]) {
      agents[role] = (await client.query(
        `INSERT INTO agents (name, role, system_prompt, model)
         VALUES ($1, $2, $3, 'openrouter/moonshotai/kimi-k3') RETURNING id::text`,
        [`FACT-34 ${role}`, role, `FACT-34 ${role} deterministic contract`],
      )).rows[0].id;
    }
    const projectId = (await client.query(
      "INSERT INTO projects (key, name) VALUES ('DMO', 'FACT-34 proof') RETURNING id::text",
    )).rows[0].id;
    const graph = {
      nodes: [
        { id: "implement", agentId: agents.implement, config: { entry: true, fanOut: { over: "openTickets", maxConcurrency: 1 }, questionEscalation: { target: "human-via-channel" } } },
        { id: "test", agentId: agents.test, config: {} },
        { id: "report", agentId: agents.report, config: {} },
      ],
      edges: [
        { source: "implement", target: "test", condition: { operator: "always" } },
        { source: "test", target: "implement", condition: { operator: "equals", path: ["artifact", "verdict"], value: "rejected" } },
        { source: "test", target: "report", condition: { operator: "equals", path: ["artifact", "verdict"], value: "approved" } },
      ],
    };
    const workflowId = (await client.query(
      "INSERT INTO workflows (name, description, graph) VALUES ('FACT-34 contract', 'Question and review loop', $1) RETURNING id::text",
      [graph],
    )).rows[0].id;
    const run = await createWorkflowRun(pool, {
      workflowId,
      triggerType: "ui",
      spec: {
        objective: "Build the documented greeting CLI",
        channelContext: { provider: "telegram", chat: { id: "-1003400", type: "supergroup" } },
      },
    });
    const ticketId = (await client.query(
      `INSERT INTO tickets (
         number, identifier, project_id, run_id, title, description,
         acceptance_criteria, status, priority
       ) VALUES (
         1, 'DMO-1', $1, $2, 'Build the greeting CLI',
         'Ask the whitespace question before implementation. The first pass omits --shout.',
         'Trim the answered name, support --shout after correction, and pass tests.',
         'todo', 3
       ) RETURNING id::text`,
      [projectId, run.id],
    )).rows[0].id;

    const calls = { implement: 0, test: 0, report: 0 };
    const scriptedProvider = {
      async wakeAgent(input) {
        calls[input.nodeId] += 1;
        if (input.nodeId === "implement" && calls.implement === 1) {
          return {
            output: {
              artifact: {},
              handoff_brief: "Waiting for the required whitespace decision.",
              events: [{ type: "question", question: "Should --name preserve surrounding whitespace or trim it?" }],
            },
          };
        }
        if (input.nodeId === "implement") {
          const listed = await dispatchPlatformTool(pool, "list_tickets", {
            agentId: agents.implement,
            runId: run.id,
            limit: 10,
            idempotencyKey: `fact34-implement-list-${calls.implement}`,
          });
          const assigned = listed.tickets.find((ticket) => ticket.id === ticketId);
          assert.ok(assigned);
          await dispatchPlatformTool(pool, "update_ticket", {
            agentId: agents.implement,
            runId: run.id,
            ticketId,
            expectedUpdatedAt: assigned.updatedAt,
            status: "done",
            idempotencyKey: `fact34-implement-done-${calls.implement}`,
          });
          return {
            output: {
              artifact: { pass: calls.implement === 2 ? "first" : "corrected" },
              handoff_brief: calls.implement === 2
                ? "Implemented the base CLI; --shout remains incomplete for review."
                : "Corrected --shout and reran the acceptance tests.",
              events: [],
            },
          };
        }
        if (input.nodeId === "test" && calls.test === 1) {
          const listed = await dispatchPlatformTool(pool, "list_tickets", {
            agentId: agents.test,
            runId: run.id,
            limit: 10,
            idempotencyKey: "fact34-test-list-rejected",
          });
          const assigned = listed.tickets.find((ticket) => ticket.id === ticketId);
          assert.ok(assigned);
          await dispatchPlatformTool(pool, "update_ticket", {
            agentId: agents.test,
            runId: run.id,
            ticketId,
            expectedUpdatedAt: assigned.updatedAt,
            status: "todo",
            idempotencyKey: "fact34-test-reopen",
          });
          return {
            output: {
              artifact: { verdict: "rejected" },
              handoff_brief: "Rejected: the documented --shout acceptance behavior is missing.",
              events: [],
            },
          };
        }
        if (input.nodeId === "test") {
          return {
            output: {
              artifact: { verdict: "approved" },
              handoff_brief: "Approved after independently checking --shout and the full test suite.",
              events: [],
            },
          };
        }
        return {
          output: {
            artifact: { status: "reported" },
            handoff_brief: "Reported the completed corrected result.",
            events: [],
          },
        };
      },
    };

    await startWorkflowRun(pool, run.id);
    const firstWorker = startWorkflowEngine(
      pool,
      new OpenClawEngineAdapter({ pool, openclaw: scriptedProvider }),
      { consumerId: "fact34-before-restart", dispatcherId: "fact34-before-restart", pollIntervalMs: 20 },
    );
    const pending = await until("durable worker question", async () => {
      const result = await client.query(
        "SELECT * FROM workflow_questions WHERE run_id = $1 AND status = 'pending'",
        [run.id],
      );
      return result.rows[0] ?? null;
    });
    assert.equal(pending.ticket_id, ticketId);
    assert.equal(pending.boundary, "worker");
    assert.equal(pending.route, "human-via-channel");

    let deliveredText = "";
    assert.equal(await deliverNextTelegramOutbound(pool, {
      async sendMessage(chatId, text) {
        assert.equal(chatId, "-1003400");
        deliveredText = text;
        return { messageId: 34001 };
      },
    }), true);
    assert.equal(deliveredText, pending.question_text);

    await firstWorker.stop();
    const answer = await ingestTelegramInbound(pool, {
      updateId: 34002,
      messageId: 34003,
      chat: { id: -1003400, type: "supergroup" },
      text: "Trim surrounding whitespace.",
      replyToMessageId: 34001,
    });
    assert.equal(answer.kind, "accepted");
    assert.equal(answer.runId, run.id);

    const restartedWorker = startWorkflowEngine(
      pool,
      new OpenClawEngineAdapter({ pool, openclaw: scriptedProvider }),
      { consumerId: "fact34-after-restart", dispatcherId: "fact34-after-restart", pollIntervalMs: 20 },
    );
    await until("completed corrected run", async () => {
      const current = await getWorkflowRun(pool, run.id);
      return current?.status === "completed" ? current : null;
    });
    await restartedWorker.stop();

    const questions = await client.query("SELECT * FROM workflow_questions WHERE run_id = $1", [run.id]);
    assert.equal(questions.rowCount, 1);
    assert.equal(questions.rows[0].status, "answered");
    assert.equal(questions.rows[0].answer_message_id, answer.messageId);

    const dispatches = await client.query(
      "SELECT node_id, ticket_id, source_message_id, status FROM workflow_dispatches WHERE run_id = $1 ORDER BY id",
      [run.id],
    );
    assert.deepEqual(dispatches.rows.map((row) => row.node_id), [
      "implement", "implement", "test", "implement", "test", "report",
    ]);
    assert.ok(dispatches.rows.every((row) => row.status === "completed"));
    assert.equal(
      dispatches.rows.filter((row) => row.source_message_id === answer.messageId).length,
      1,
      "the Telegram answer resumes exactly one ticket thread",
    );

    const testerOutputs = await client.query(
      `SELECT message.payload #>> '{output,artifact,verdict}' AS verdict
       FROM messages AS message
       JOIN workflow_dispatches AS dispatch ON dispatch.output_message_id = message.id
       WHERE message.run_id = $1 AND dispatch.node_id = 'test'
       ORDER BY message.id`,
      [run.id],
    );
    assert.deepEqual(testerOutputs.rows.map((row) => row.verdict), ["rejected", "approved"]);

    const trail = await client.query(
      "SELECT type::text, ticket_id, payload FROM messages WHERE run_id = $1 ORDER BY sequence_number",
      [run.id],
    );
    const questionMessage = trail.rows.find((row) => row.type === "question");
    assert.deepEqual(questionMessage.payload.runtimeEvent, {
      type: "question",
      question: "Should --name preserve surrounding whitespace or trim it?",
    });
    assert.ok(trail.rows.some((row) => row.type === "channel_outbound"));
    assert.ok(trail.rows.some((row) => row.type === "answer"));
    assert.equal((await client.query("SELECT status::text FROM tickets WHERE id = $1", [ticketId])).rows[0].status, "done");
    assert.deepEqual(calls, { implement: 3, test: 2, report: 1 });
  } finally {
    await pool.end();
    await client.end();
  }
});
