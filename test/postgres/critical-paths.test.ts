import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { POST as createAgent, GET as listAgents } from "../../src/app/api/agents/route.ts";
import {
  DELETE as deleteAgent,
  GET as getAgent,
  PATCH as updateAgent,
} from "../../src/app/api/agents/[id]/route.ts";
import { resetControlPlaneRepository } from "../../src/lib/control-plane/index.ts";
import { OpenClawEngineAdapter } from "../../src/lib/runtime/engine-adapter.ts";
import { OpenClawRuntimeAdapter } from "../../src/lib/runtime/openclaw.ts";
import { insertMessage, type JsonObject } from "../../src/lib/postgres/message-bus.ts";
import {
  consumeNextWorkflowMessage,
  createWorkflowRun,
  dispatchNextWorkflowNode,
  getWorkflowRun,
  pauseWorkflowRun,
  startWorkflowRun,
  type RuntimeDispatchRequest,
  type RuntimeReconciliationResult,
  type RuntimeStartResult,
} from "../../src/lib/postgres/workflow-engine.ts";
import { ingestTelegramInbound } from "../../src/lib/telegram/adapter.ts";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";

const { Client, Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const expectedDatabase = process.env.ORBITFLOW_FACT26_PROOF_DATABASE;
const migrationDirectory = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const fakeOpenClaw = fileURLToPath(new URL("../runtime/fixtures/fake-openclaw.mjs", import.meta.url));
const migrationFile = /^\d{4}-[a-z0-9-]+\.sql$/;
let identity: pg.Client;
let pool: pg.Pool;

class MockRuntime {
  readonly calls: RuntimeDispatchRequest[] = [];

  async startSession(request: RuntimeDispatchRequest): Promise<RuntimeStartResult> {
    this.calls.push(request);
    return { kind: "started", sessionId: `fact26-mock-${request.dispatchId}` };
  }

  async reconcileSession(_request: RuntimeDispatchRequest): Promise<RuntimeReconciliationResult> {
    return { kind: "absent" };
  }
}

function request(body: unknown): Request {
  return new Request("http://orbitflow.test/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function committedMigrations(): Promise<string[]> {
  return (await readdir(migrationDirectory)).filter((name) => migrationFile.test(name)).sort();
}

async function insertAgent(pool: pg.Pool, name: string, options: {
  prompt?: string;
  guardrails?: object;
  channelBinding?: object | null;
  memory?: object;
} = {}): Promise<string> {
  const result = await pool.query(
    `INSERT INTO agents (name, role, system_prompt, model, guardrails, channel_binding, memory)
     VALUES ($1, 'FACT-26 proof agent', $2, 'mock/fact26', $3::jsonb, $4::jsonb, $5::jsonb)
     RETURNING id::text`,
    [
      name,
      options.prompt ?? `Execute ${name} safely.`,
      JSON.stringify(options.guardrails ?? {}),
      options.channelBinding === undefined || options.channelBinding === null
        ? null
        : JSON.stringify(options.channelBinding),
      JSON.stringify(options.memory ?? {}),
    ],
  );
  return result.rows[0]!.id;
}

async function insertWorkflow(pool: pg.Pool, name: string, graph: object): Promise<string> {
  const result = await pool.query(
    `INSERT INTO workflows (name, description, graph)
     VALUES ($1, 'FACT-26 critical-path proof', $2::jsonb)
     RETURNING id::text`,
    [name, JSON.stringify(graph)],
  );
  return result.rows[0]!.id;
}

async function dispatch(pool: pg.Pool, runId: string, nodeId: string) {
  const result = await pool.query(
    `SELECT * FROM workflow_dispatches
     WHERE run_id = $1 AND node_id = $2
     ORDER BY id DESC LIMIT 1`,
    [runId, nodeId],
  );
  assert.ok(result.rows[0], `missing ${nodeId} dispatch`);
  return result.rows[0]!;
}

async function publishOutput(
  pool: pg.Pool,
  dispatchRow: Record<string, unknown>,
  output: JsonObject,
  handoffBrief: string,
  tokenUsage: JsonObject | null = null,
) {
  const message = await insertMessage(pool, {
    runId: String(dispatchRow.run_id),
    ticketId: dispatchRow.ticket_id === null ? null : String(dispatchRow.ticket_id),
    sender: `agent:${dispatchRow.agent_id}`,
    recipient: "system:workflow-engine",
    type: "output",
    payload: {
      dispatchId: String(dispatchRow.id),
      dispatchGeneration: String(dispatchRow.runtime_generation),
      sessionId: String(dispatchRow.runtime_session_id),
      output,
    },
    handoffBrief,
    tokenUsage,
  });
  let consumedId: string | undefined;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const consumed = await consumeNextWorkflowMessage(pool, { consumerId: `fact26-${message.id}` });
    if (consumed && consumed.message.id === message.id) {
      consumedId = consumed.message.id;
      break;
    }
  }
  assert.equal(consumedId, message.id, "the durable producer message must reach the engine");
  return message;
}

before(async () => {
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable FACT-26 proof database");
  assert.ok(expectedDatabase, "ORBITFLOW_FACT26_PROOF_DATABASE must name the disposable proof database");
  assert.equal(process.env.OPENROUTER_API_KEY, undefined, "FACT-26 must not use provider credentials");
  assert.equal(process.env.TELEGRAM_BOT_TOKEN, undefined, "FACT-26 must not use Telegram credentials");

  identity = new Client({ connectionString: databaseUrl });
  pool = new Pool({ connectionString: databaseUrl, max: 8 });
  await identity.connect();
  const database = await identity.query<{ name: string }>("SELECT current_database() AS name");
  assert.equal(database.rows[0]!.name, expectedDatabase);
  const migration = await migratePostgres({ databaseUrl, log: () => {} });
  assert.deepEqual(migration.applied, await committedMigrations());
});

test("1. Agent CRUD round trip through API and PostgreSQL persistence", async () => {
      await resetControlPlaneRepository();
      const createdResponse = await createAgent(request({
        name: "FACT-26 API agent",
        role: "proof worker",
        systemPrompt: "Persist this agent through the route handler.",
        model: "mock/api",
        codingToolEnabled: false,
        guardrails: {},
        interactionRules: {},
        channelBinding: null,
        memory: { proof: "created" },
        openclawRef: null,
      }));
      assert.equal(createdResponse.status, 201);
      const created = await createdResponse.json() as { id: string; updatedAt: string; name: string };
      assert.equal(created.name, "FACT-26 API agent");

      const readResponse = await getAgent(new Request("http://orbitflow.test/api/agents"), context(created.id));
      assert.equal(readResponse.status, 200);
      const read = await readResponse.json() as { name: string; memory: object; updatedAt: string };
      assert.deepEqual(read.memory, { proof: "created" });

      const patchedResponse = await updateAgent(request({
        name: "FACT-26 API agent updated",
        memory: { proof: "updated" },
        expectedUpdatedAt: read.updatedAt,
      }), context(created.id));
      assert.equal(patchedResponse.status, 200);
      const patched = await patchedResponse.json() as { name: string; memory: object };
      assert.equal(patched.name, "FACT-26 API agent updated");
      assert.deepEqual(patched.memory, { proof: "updated" });

      const persisted = await pool.query(
        "SELECT name, memory FROM agents WHERE id = $1",
        [created.id],
      );
      assert.deepEqual(persisted.rows[0], {
        name: "FACT-26 API agent updated",
        memory: { proof: "updated" },
      });
      const listedResponse = await listAgents();
      assert.equal(listedResponse.status, 200);
      assert.ok((await listedResponse.json() as { id: string }[]).some((agent) => agent.id === created.id));

      const deletedResponse = await deleteAgent(new Request("http://orbitflow.test/api/agents"), context(created.id));
      assert.equal(deletedResponse.status, 204);
      const removed = await pool.query("SELECT count(*)::int AS count FROM agents WHERE id = $1", [created.id]);
      assert.equal(removed.rows[0]!.count, 0);
      await resetControlPlaneRepository();
});

test("2. Workflow graph rejection loop and fan-out through a mock runtime adapter", async () => {
      const implementer = await insertAgent(pool, "FACT-26 graph implementer");
      const reviewer = await insertAgent(pool, "FACT-26 graph reviewer");
      const worker = await insertAgent(pool, "FACT-26 graph worker");
      const workflowId = await insertWorkflow(pool, "FACT-26 graph workflow", {
        nodes: [
          { id: "implement", agentId: implementer, config: { entry: true } },
          { id: "review", agentId: reviewer, config: {} },
          { id: "fanout", agentId: worker, config: { fanOut: { maxConcurrency: 2 } } },
        ],
        edges: [
          { source: "implement", target: "review", condition: { operator: "always" } },
          { source: "review", target: "implement", condition: { operator: "equals", path: ["verdict"], value: "rejected" } },
          { source: "review", target: "fanout", condition: { operator: "equals", path: ["verdict"], value: "approved" } },
        ],
      });
      const run = await createWorkflowRun(pool, {
        workflowId,
        triggerType: "ui",
        spec: { objective: "exercise rejection and fan-out" },
      });
      await pool.query("INSERT INTO projects (key, name) VALUES ('FCT', 'FACT-26 proof')");
      for (const number of [1, 2]) {
        await pool.query(
          `INSERT INTO tickets (number, identifier, project_id, run_id, title, status, priority)
           SELECT $1, $2, id, $3, $4, 'todo', 1 FROM projects WHERE key = 'FCT'`,
          [number, `FCT-${number}`, run.id, `Fan-out ticket ${number}`],
        );
      }
      await startWorkflowRun(pool, run.id);
      const runtime = new MockRuntime();

      await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact26-graph" });
      await publishOutput(pool, await dispatch(pool, run.id, "implement"), { artifact: "first" }, "implementation ready");
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact26-graph" });
      await publishOutput(pool, await dispatch(pool, run.id, "review"), { verdict: "rejected" }, "review rejected");
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact26-graph" });
      await publishOutput(pool, await dispatch(pool, run.id, "implement"), { artifact: "fixed" }, "fix ready");
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact26-graph" });
      await publishOutput(pool, await dispatch(pool, run.id, "review"), { verdict: "approved" }, "review approved");

      const materialized = await pool.query(
        "SELECT ticket_id::text FROM workflow_dispatches WHERE run_id = $1 AND node_id = 'fanout' ORDER BY ticket_id",
        [run.id],
      );
      assert.equal(materialized.rowCount, 2);
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact26-fanout-a" });
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact26-fanout-b" });
      assert.deepEqual(runtime.calls.map((call) => call.nodeId), ["implement", "review", "implement", "review", "fanout", "fanout"]);
      assert.ok(runtime.calls.slice(-2).every((call) => call.ephemeral));
});

test("3. Producer to bus to engine dispatch invokes the credentialless composed runtime adapter", async () => {
      const source = await insertAgent(pool, "FACT-26 message source");
      const target = await insertAgent(pool, "FACT-26 composed target", {
        prompt: "Follow the FACT-26 composed delivery prompt.",
        memory: { retained: "PostgreSQL is authoritative" },
      });
      const workflowId = await insertWorkflow(pool, "FACT-26 message workflow", {
        nodes: [
          { id: "source", agentId: source, config: { entry: true } },
          { id: "target", agentId: target, config: {} },
        ],
        edges: [{ source: "source", target: "target", condition: { operator: "always" } }],
      });
      const run = await createWorkflowRun(pool, {
        workflowId,
        triggerType: "ui",
        spec: { objective: "prove durable composed dispatch" },
      });
      await startWorkflowRun(pool, run.id);
      const sourceRuntime = new MockRuntime();
      await dispatchNextWorkflowNode(pool, sourceRuntime, { workerId: "fact26-source" });
      const produced = await publishOutput(
        pool,
        await dispatch(pool, run.id, "source"),
        { artifact: "source output" },
        "handoff from durable producer",
      );
      assert.ok(produced.id, "the runtime output is retained by the message-bus producer");

      const runtimeRoot = await mkdtemp(path.join(tmpdir(), "orbitflow-fact26-runtime-"));
      const stateDirectory = path.join(runtimeRoot, "state");
      await mkdir(stateDirectory, { recursive: true });
      await writeFile(path.join(stateDirectory, "fake-plan.json"), JSON.stringify([{
        mode: "success",
        output: {
          artifact: { accepted: true },
          handoff_brief: "target completed",
          events: [{ type: "proof" }],
        },
      }]));
      try {
        const openclaw = new OpenClawRuntimeAdapter({
          pool,
          runtimeRoot,
          openClawCommand: process.execPath,
          openClawCommandArguments: [fakeOpenClaw],
          wakeTimeoutMs: 2_000,
          terminationGraceMs: 100,
        });
        const adapter = new OpenClawEngineAdapter({
          pool,
          openclaw,
          workspaceTools: () => "# FACT-26 test tools\nUse the documented adapter boundary.",
        });
        const started = await dispatchNextWorkflowNode(pool, adapter, { workerId: "fact26-composed" });
        assert.equal(started?.nodeId, "target");
        const requests = (await readFile(path.join(stateDirectory, "fake-requests.ndjson"), "utf8"))
          .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        const agentRequest = requests.find((entry) => entry.command === "agent");
        assert.ok(agentRequest, "the fake OpenClaw adapter received one invocation");
        assert.match(agentRequest.message, /Follow the FACT-26 composed delivery prompt\./);
        assert.match(agentRequest.message, /handoff from durable producer/);
        assert.match(agentRequest.message, /PostgreSQL is authoritative/);
        assert.ok(requests.every((entry) => entry.gatewayCredentialPresent === false));
        assert.ok(requests.every((entry) => entry.forbiddenEnvironmentPresent.length === 0));
        const output = await pool.query(
          "SELECT id::text FROM messages WHERE run_id = $1 AND sender = $2 AND type = 'output' ORDER BY id DESC LIMIT 1",
          [run.id, `agent:${target}`],
        );
        let consumedOutput: string | undefined;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const consumed = await consumeNextWorkflowMessage(pool, { consumerId: "fact26-composed-output" });
          if (consumed && consumed.message.id === output.rows[0]!.id) {
            consumedOutput = consumed.message.id;
            break;
          }
        }
        assert.equal(consumedOutput, output.rows[0]!.id, "the composed runtime output returns through the durable bus");
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
});

test("4. Telegram inbound creates one channel-triggered workflow run through a mock boundary", async () => {
      await pool.query("UPDATE agents SET channel_binding = NULL");
      const telegramAgent = await insertAgent(pool, "FACT-26 Telegram entry", {
        channelBinding: { provider: "telegram", workflow: "FACT-26 Telegram workflow" },
      });
      const workflowId = await insertWorkflow(pool, "FACT-26 Telegram workflow", {
        nodes: [{ id: "telegram-entry", agentId: telegramAgent, config: { entry: true, channelBinding: true } }],
        edges: [],
      });
      assert.ok(workflowId);
      const mockTelegramUpdate = {
        updateId: 26001,
        messageId: 26002,
        chat: { id: -1002600, type: "supergroup", username: "fact26" },
        from: { id: 26, firstName: "Proof" },
        text: "Run the channel workflow once.",
      };
      const accepted = await ingestTelegramInbound(pool, mockTelegramUpdate);
      assert.equal(accepted.kind, "accepted");
      if (accepted.kind !== "accepted") return;
      const duplicate = await ingestTelegramInbound(pool, mockTelegramUpdate);
      assert.deepEqual(duplicate, { kind: "duplicate", runId: accepted.runId, messageId: accepted.messageId });
      const runs = await pool.query(
        "SELECT trigger_type, count(*)::int AS count FROM workflow_runs WHERE id = $1 GROUP BY trigger_type",
        [accepted.runId],
      );
      assert.deepEqual(runs.rows[0], { trigger_type: "channel", count: 1 });
      const receipts = await pool.query("SELECT count(*)::int AS count FROM telegram_inbound_updates WHERE update_id = 26001");
      assert.equal(receipts.rows[0]!.count, 1);
      const inbound = await consumeNextWorkflowMessage(pool, { consumerId: "fact26-telegram-inbound" });
      assert.equal(inbound?.message.id, accepted.messageId);
      assert.equal((await pauseWorkflowRun(pool, accepted.runId)).status, "paused");
});

test("5. Cost ceiling halts a run through the real guardrail state transition", async () => {
      const agentId = await insertAgent(pool, "FACT-26 cost ceiling agent");
      const workflowId = await insertWorkflow(pool, "FACT-26 guardrail workflow", {
        nodes: [{ id: "work", agentId, config: { entry: true } }],
        edges: [{ source: "work", target: "work", condition: { operator: "always" } }],
      });
      const run = await createWorkflowRun(pool, {
        workflowId,
        triggerType: "ui",
        spec: { objective: "halt at exact run ceiling", guardrails: { costLimit: 0.5 } },
      });
      await startWorkflowRun(pool, run.id);
      const runtime = new MockRuntime();
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact26-guardrail" });
      await publishOutput(
        pool,
        await dispatch(pool, run.id, "work"),
        { artifact: "spent at ceiling" },
        "cost recorded",
        { input: 2, output: 1, total: 3, cost: 0.5 },
      );
      assert.equal(await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact26-guardrail" }), null);
      assert.equal(runtime.calls.length, 1, "the refused wake never reaches the runtime adapter");
      assert.equal((await getWorkflowRun(pool, run.id))?.status, "paused");
      const pause = await pool.query(
        `SELECT payload FROM messages
         WHERE run_id = $1 AND type = 'system' AND sender = 'system:workflow-engine'`,
        [run.id],
      );
      assert.equal(pause.rowCount, 1);
      assert.equal(pause.rows[0]!.payload.code, "guardrail_cost_ceiling");
      assert.equal(pause.rows[0]!.payload.scope, "run");
});

after(async () => {
  await resetControlPlaneRepository();
  await pool.end();
  await identity.end();
});
