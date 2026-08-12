import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { GET as listAgents, POST as createAgent } from "@/app/api/agents/route";
import { DELETE as deleteAgent, GET as getAgent, PATCH as patchAgent } from "@/app/api/agents/[id]/route";
import { DELETE as detachSkill, PUT as attachSkill } from "@/app/api/agents/[id]/skills/[skillId]/route";
import { GET as listAgentSchedules, POST as createAgentSchedule } from "@/app/api/agents/[id]/schedules/route";
import { DELETE as deleteSchedule, PATCH as patchSchedule } from "@/app/api/schedules/[id]/route";
import { POST as triggerSchedule } from "@/app/api/schedules/[id]/trigger/route";
import { GET as listSkills, POST as createSkill } from "@/app/api/skills/route";
import { DELETE as deleteSkill, GET as getSkill, PATCH as patchSkill } from "@/app/api/skills/[id]/route";
import { GET as listWorkflows, POST as createWorkflow } from "@/app/api/workflows/route";
import { DELETE as deleteWorkflow, GET as getWorkflow, PATCH as patchWorkflow } from "@/app/api/workflows/[id]/route";
import { GET as getMonitoring } from "@/app/api/monitoring/route";
import {
  ControlPlaneRepository,
  getControlPlaneRepository,
  resetControlPlaneRepository,
} from "@/lib/control-plane";
import { handleError } from "@/lib/api";
import { canonicalWorkflowGraphJson, type WorkflowGraph } from "@/lib/workflow/graph-contract";
import { migratePostgres } from "../scripts/migrate-postgres.mjs";

const databaseUrl = process.env.DATABASE_URL;

const agentBody = {
  name: "Orchestrator",
  role: "manager",
  systemPrompt: "Coordinate work without losing the human's intent.",
  model: "openrouter/fast-model",
  codingToolEnabled: true,
  guardrails: { costLimit: 12.5, rateLimit: { perMinute: 8 }, blockedActions: ["deploy"] },
  interactionRules: { mayAnswerQuestions: true, autonomy: "ask-before-risk" },
  channelBinding: { provider: "telegram", chatId: "42" },
  memory: { facts: ["Adam prefers concise runbooks"] },
  openclawRef: "openclaw:orchestrator",
};

const workflowGraph = {
  nodes: [
    { id: "intake", agentId: "1", config: { entry: true, planMode: "required" } },
    { id: "implement", agentId: 2, config: { fanOut: { over: "openTickets", maxConcurrency: 3 } } },
  ],
  edges: [
    { source: "intake", target: "implement", condition: { operator: "equals", path: ["verdict"], value: "ready" } },
  ],
  builderMetadata: { viewport: { x: 10, y: -4, zoom: 1.1 } },
};

let pool: Pool;

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

function skillContext(id: string, skillId: string) {
  return { params: Promise.resolve({ id, skillId }) };
}

function jsonRequest(body: unknown): Request {
  return new Request("http://orbitfactory.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function response(response: Response) {
  return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
}

beforeAll(async () => {
  if (!databaseUrl) return;
  await migratePostgres({ databaseUrl, log: () => {} });
  pool = new Pool({ connectionString: databaseUrl, application_name: "orbitfactory-fact8-proof" });
}, 60_000);

beforeEach(async () => {
  if (!pool) return;
  await pool.query("TRUNCATE schedules, agent_skills, skills, agents, workflows RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await resetControlPlaneRepository();
  if (pool) await pool.end();
});

describe.skipIf(!databaseUrl)("FACT-8 PostgreSQL CRUD control plane", () => {
  it("round-trips every agent field without filling nullable values or mutating JSON", async () => {
    const created = await response(await createAgent(jsonRequest(agentBody)));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ ...agentBody, id: "1", skills: [] });
    expect(created.body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await response(await listAgents())).body.map((agent: { id: string }) => agent.id)).toEqual([created.body.id]);

    const updated = await response(await patchAgent(jsonRequest({
      channelBinding: {},
      guardrails: { costLimit: 0, blockedActions: [] },
      expectedUpdatedAt: created.body.updatedAt,
    }), context(created.body.id)));
    expect(updated.status).toBe(200);
    expect(updated.body.channelBinding).toEqual({});
    expect(updated.body.guardrails).toEqual({ costLimit: 0, blockedActions: [] });
    expect(updated.body.interactionRules).toEqual(agentBody.interactionRules);
    expect(updated.body.memory).toEqual(agentBody.memory);

    const cleared = await response(await patchAgent(jsonRequest({
      channelBinding: null,
      openclawRef: null,
      expectedUpdatedAt: updated.body.updatedAt,
    }), context(created.body.id)));
    expect(cleared.status).toBe(200);
    expect(cleared.body.channelBinding).toBeNull();
    expect(cleared.body.openclawRef).toBeNull();

    const reread = await response(await getAgent(new Request("http://orbitfactory.test"), context(created.body.id)));
    expect(reread.status).toBe(200);
    expect(reread.body).toEqual(cleared.body);

    const duplicate = await response(await createAgent(jsonRequest({ ...agentBody, openclawRef: "different" })));
    expect(duplicate).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });

    expect((await response(await deleteAgent(new Request("http://orbitfactory.test"), context(created.body.id)))).status).toBe(204);
    expect((await response(await getAgent(new Request("http://orbitfactory.test"), context(created.body.id)))).status).toBe(404);
  });

  it("creates, updates, reads, and deletes skills through PostgreSQL", async () => {
    const created = await response(await createSkill(jsonRequest({
      name: "Postgres proof",
      description: "Run database-backed checks.",
      procedure: "Run npm run fact8:proof.",
    })));
    expect(created.status).toBe(201);
    expect((await response(await listSkills())).body.map((skill: { id: string }) => skill.id)).toEqual([created.body.id]);
    const updated = await response(await patchSkill(jsonRequest({
      procedure: "Run the clean database proof.",
      expectedUpdatedAt: created.body.updatedAt,
    }), context(created.body.id)));
    expect(updated).toMatchObject({ status: 200, body: { procedure: "Run the clean database proof." } });
    expect((await response(await deleteSkill(new Request("http://orbitfactory.test"), context(created.body.id)))).status).toBe(204);
    expect((await response(await deleteSkill(new Request("http://orbitfactory.test"), context(created.body.id)))).status).toBe(404);
  });

  it("attaches and detaches skills idempotently, and cascades a deleted skill", async () => {
    const agent = await response(await createAgent(jsonRequest(agentBody)));
    const skill = await response(await createSkill(jsonRequest({ name: "Review", description: "Review a diff.", procedure: "Read it." })));

    const firstAttach = await response(await attachSkill(new Request("http://orbitfactory.test", { method: "PUT" }), skillContext(agent.body.id, skill.body.id)));
    const secondAttach = await response(await attachSkill(new Request("http://orbitfactory.test", { method: "PUT" }), skillContext(agent.body.id, skill.body.id)));
    expect(firstAttach).toEqual({ status: 200, body: { attached: true } });
    expect(secondAttach).toEqual({ status: 200, body: { attached: true } });
    expect((await response(await getAgent(new Request("http://orbitfactory.test"), context(agent.body.id)))).body.skills).toHaveLength(1);

    expect((await response(await deleteSkill(new Request("http://orbitfactory.test"), context(skill.body.id)))).status).toBe(204);
    expect((await response(await getAgent(new Request("http://orbitfactory.test"), context(agent.body.id)))).body.skills).toEqual([]);
    expect((await response(await detachSkill(new Request("http://orbitfactory.test", { method: "DELETE" }), skillContext(agent.body.id, skill.body.id)))).status).toBe(404);
  });

  it("persists direct agent schedules without introducing schedule execution", async () => {
    const agent = await response(await createAgent(jsonRequest(agentBody)));
    const created = await response(await createAgentSchedule(jsonRequest({
      cronExpression: "0 9 * * 1-5",
      taskPrompt: "Prepare the daily standup.",
      enabled: true,
    }), context(agent.body.id)));
    expect(created).toMatchObject({
      status: 201,
      body: {
        agentId: agent.body.id,
        workflowId: null,
        cronExpression: "0 9 * * 1-5",
        taskPrompt: "Prepare the daily standup.",
        enabled: true,
      },
    });
    expect((await response(await listAgentSchedules(new Request("http://orbitfactory.test"), context(agent.body.id)))).body).toEqual([created.body]);

    const updated = await response(await patchSchedule(jsonRequest({
      taskPrompt: "Prepare a concise daily standup.",
      enabled: false,
      expectedUpdatedAt: created.body.updatedAt,
    }), context(created.body.id)));
    expect(updated).toMatchObject({ status: 200, body: { taskPrompt: "Prepare a concise daily standup.", enabled: false } });
    expect(await response(await patchSchedule(jsonRequest({
      enabled: true,
      cronExpression: "0 9 * * 1-5",
      expectedUpdatedAt: created.body.updatedAt,
    }), context(created.body.id)))).toMatchObject({ status: 409, body: { error: { code: "stale_update" } } });
    expect((await response(await deleteSchedule(new Request("http://orbitfactory.test"), context(created.body.id)))).status).toBe(204);
  });

  it("exposes manual schedule triggering with an idempotent request identity", async () => {
    const agent = await response(await createAgent(jsonRequest(agentBody)));
    const schedule = await response(await createAgentSchedule(jsonRequest({
      cronExpression: "0 9 * * 1-5",
      taskPrompt: "Run the scheduled check.",
      enabled: true,
    }), context(agent.body.id)));

    const first = await response(await triggerSchedule(jsonRequest({ idempotencyKey: "fact-33-first" }), context(schedule.body.id)));
    const duplicate = await response(await triggerSchedule(jsonRequest({ idempotencyKey: "fact-33-first" }), context(schedule.body.id)));
    expect(first).toMatchObject({ status: 200, body: { kind: "created", scheduleId: schedule.body.id } });
    expect(duplicate).toMatchObject({ status: 200, body: { kind: "duplicate", runId: first.body.runId, messageId: first.body.messageId } });
    expect(await response(await triggerSchedule(jsonRequest({}), context(schedule.body.id)))).toMatchObject({
      status: 400, body: { error: { code: "invalid_idempotency_key" } },
    });
  });

  it("accepts only the documented cron grammar and refuses workflow schedule mutation", async () => {
    const agent = await response(await createAgent(jsonRequest(agentBody)));
    const valid = await response(await createAgentSchedule(jsonRequest({
      cronExpression: "*/15 0,12 1-31/2 1-12 1-5",
      taskPrompt: "Check the control plane.",
      enabled: true,
    }), context(agent.body.id)));
    expect(valid.status).toBe(201);
    expect(await response(await createAgentSchedule(jsonRequest({
      cronExpression: "0 9 * * MON",
      taskPrompt: "This grammar is intentionally unsupported.",
      enabled: true,
    }), context(agent.body.id)))).toMatchObject({ status: 400, body: { error: { code: "invalid_cron" } } });
    expect(await response(await createAgentSchedule(jsonRequest({
      cronExpression: "59-0 * * * *",
      taskPrompt: "Reverse ranges are invalid.",
      enabled: true,
    }), context(agent.body.id)))).toMatchObject({ status: 400, body: { error: { code: "invalid_cron" } } });
    expect(await response(await patchSchedule(jsonRequest({
      enabled: true,
      expectedUpdatedAt: valid.body.updatedAt,
    }), context(valid.body.id)))).toMatchObject({ status: 400, body: { error: { code: "invalid_cron" } } });

    const workflow = await response(await createWorkflow(jsonRequest({
      name: "Schedule boundary workflow",
      description: "Owns a schedule outside FACT-19.",
      graph: workflowGraph,
      isTemplate: false,
    })));
    const inserted = await pool.query(
      "INSERT INTO schedules (cron_expression, workflow_id, enabled) VALUES ($1, $2, true) RETURNING id, updated_at",
      ["0 8 * * 1-5", workflow.body.id],
    );
    const workflowScheduleId = String(inserted.rows[0]!.id);
    const workflowScheduleUpdatedAt = String(inserted.rows[0]!.updated_at);
    expect(await response(await patchSchedule(jsonRequest({
      cronExpression: "0 10 * * 1-5",
      expectedUpdatedAt: workflowScheduleUpdatedAt,
    }), context(workflowScheduleId)))).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    expect((await response(await deleteSchedule(new Request("http://orbitfactory.test"), context(workflowScheduleId)))).status).toBe(404);
    const preserved = await pool.query("SELECT cron_expression, workflow_id FROM schedules WHERE id = $1", [workflowScheduleId]);
    expect(preserved.rows).toEqual([{ cron_expression: "0 8 * * 1-5", workflow_id: workflow.body.id }]);
  });

  it("preserves a valid workflow graph value and rejects malformed graph structure", async () => {
    const created = await response(await createWorkflow(jsonRequest({
      name: "Software Factory",
      description: "A graph with a handoff.",
      graph: workflowGraph,
      isTemplate: true,
    })));
    expect(created.status).toBe(201);
    expect(created.body.graph).toEqual(workflowGraph);
    expect((await response(await listWorkflows())).body.map((workflow: { id: string }) => workflow.id)).toEqual([created.body.id]);

    const reread = await response(await getWorkflow(new Request("http://orbitfactory.test"), context(created.body.id)));
    expect(reread.body.graph).toEqual(workflowGraph);
    const changedGraph = { ...workflowGraph, builderMetadata: { viewport: { x: 0, y: 0, zoom: 1 } } };
    const updated = await response(await patchWorkflow(jsonRequest({
      graph: changedGraph,
      expectedUpdatedAt: created.body.updatedAt,
    }), context(created.body.id)));
    expect(updated.body.graph).toEqual(changedGraph);

    const duplicateEdgeGraph = {
      ...changedGraph,
      edges: [
        ...changedGraph.edges,
        { source: "intake", target: "implement", condition: { operator: "equals", path: ["verdict"], value: "ready" } },
      ],
    };
    const duplicateOnUpdate = await response(await patchWorkflow(jsonRequest({
      graph: duplicateEdgeGraph,
      expectedUpdatedAt: updated.body.updatedAt,
    }), context(created.body.id)));
    expect(duplicateOnUpdate).toMatchObject({ status: 400, body: { error: { code: "invalid_graph" } } });

    const duplicateOnCreate = await response(await createWorkflow(jsonRequest({
      name: "Duplicate transition",
      description: "Should not persist.",
      graph: {
        nodes: [{ id: "one", agentId: 1, config: { entry: true } }, { id: "two", agentId: 2, config: {} }],
        edges: [
          { source: "one", target: "two", condition: { operator: "equals", path: ["verdict"], value: { first: true, second: false } } },
          { source: "one", target: "two", condition: { value: { second: false, first: true }, path: ["verdict"], operator: "equals" } },
        ],
      },
      isTemplate: false,
    })));
    expect(duplicateOnCreate).toMatchObject({ status: 400, body: { error: { code: "invalid_graph" } } });

    const malformed = await response(await createWorkflow(jsonRequest({
      name: "Broken",
      description: "Should not persist.",
      graph: { nodes: [{ id: "one", agentId: 1, config: { entry: true } }], edges: [{ source: "one", target: "missing", condition: { operator: "always" } }] },
      isTemplate: false,
    })));
    expect(malformed).toMatchObject({ status: 400, body: { error: { code: "invalid_graph" } } });
    expect((await getControlPlaneRepository().listWorkflows()).map((workflow) => workflow.name)).toEqual(["Software Factory"]);

    expect((await response(await deleteWorkflow(new Request("http://orbitfactory.test"), context(created.body.id)))).status).toBe(204);
  });

  it("round-trips a three-node rejection loop byte-equivalently and rejects a stale graph save", async () => {
    const graph: WorkflowGraph = {
      nodes: [
        {
          id: "implement",
          agentId: "1",
          config: {
            entry: true,
            channelBinding: true,
            fanOut: { over: "openTickets", maxConcurrency: 2 },
            planMode: "required",
            may_answer_questions: true,
            questionEscalation: { target: "human-via-channel" },
            approvalGates: { pauseBefore: false, pauseAfter: true },
            futureEngineField: { keep: "opaque" },
          },
        },
        { id: "test", agentId: "2", config: { entry: false } },
        { id: "review", agentId: "2", config: { entry: false } },
      ],
      edges: [
        { source: "implement", target: "test", condition: { operator: "always" } },
        { source: "test", target: "review", condition: { operator: "always" } },
        {
          source: "review",
          target: "implement",
          condition: { operator: "equals", path: ["verdict"], value: "rejected" },
          futureEdgeField: { keep: true },
        },
      ],
      builderMetadata: {
        positions: {
          implement: { x: 20, y: 40 },
          test: { x: 360, y: 40 },
          review: { x: 700, y: 40 },
        },
      },
    };
    const created = await response(await createWorkflow(jsonRequest({
      name: "PostgreSQL rejection loop",
      description: "FACT-20 identity proof",
      graph,
      isTemplate: false,
    })));
    expect(created.status).toBe(201);

    const reread = await response(await getWorkflow(new Request("http://orbitfactory.test"), context(created.body.id)));
    expect(canonicalWorkflowGraphJson(reread.body.graph)).toBe(canonicalWorkflowGraphJson(graph));

    const winner = await response(await patchWorkflow(jsonRequest({
      graph,
      expectedUpdatedAt: created.body.updatedAt,
    }), context(created.body.id)));
    expect(winner.status).toBe(200);
    const stale = await response(await patchWorkflow(jsonRequest({
      graph: { ...graph, futureTopLevelField: "stale writer" },
      expectedUpdatedAt: created.body.updatedAt,
    }), context(created.body.id)));
    expect(stale).toMatchObject({ status: 409, body: { error: { code: "stale_update" } } });

    const finalRead = await response(await getWorkflow(new Request("http://orbitfactory.test"), context(created.body.id)));
    expect(canonicalWorkflowGraphJson(finalRead.body.graph)).toBe(canonicalWorkflowGraphJson(graph));
  });

  it("returns structured validation, not-found, conflict, and database errors", async () => {
    const invalid = await response(await createAgent(jsonRequest({ ...agentBody, channelBinding: [] })));
    expect(invalid).toMatchObject({ status: 400, body: { error: { code: "invalid_type" } } });
    const nonObject = await response(await createAgent(jsonRequest(null)));
    expect(nonObject).toMatchObject({ status: 400, body: { error: { code: "invalid_type" } } });
    expect((await response(await getAgent(new Request("http://orbitfactory.test"), context("999")))).status).toBe(404);

    const agent = await response(await createAgent(jsonRequest(agentBody)));
    const missingPrecondition = await response(await patchAgent(jsonRequest({ role: "reviewer" }), context(agent.body.id)));
    expect(missingPrecondition).toMatchObject({ status: 400, body: { error: { code: "missing_precondition" } } });
    const skill = await response(await createSkill(jsonRequest({ name: "Precondition skill", description: "x", procedure: "y" })));
    expect(await response(await patchSkill(jsonRequest({ description: "changed" }), context(skill.body.id)))).toMatchObject({
      status: 400,
      body: { error: { code: "missing_precondition" } },
    });
    const workflow = await response(await createWorkflow(jsonRequest({
      name: "Precondition workflow",
      description: "x",
      graph: workflowGraph,
      isTemplate: false,
    })));
    expect(await response(await patchWorkflow(jsonRequest({ description: "changed" }), context(workflow.body.id)))).toMatchObject({
      status: 400,
      body: { error: { code: "missing_precondition" } },
    });

    const databaseFailure = await response(handleError(Object.assign(new Error("postgresql://secret@example.test"), { code: "08006" })));
    expect(databaseFailure).toEqual({
      status: 500,
      body: { error: { message: "internal server error", code: "internal" } },
    });
  });

  it("rolls back a repository transaction and lets one route-level client update each shared version", async () => {
    const repository = new ControlPlaneRepository(pool);
    await expect(repository.transaction(async (client) => {
      await client.query("INSERT INTO skills (name, description, procedure) VALUES ('rolled back', 'x', 'y')");
      throw new Error("force rollback");
    })).rejects.toThrow("force rollback");
    expect((await repository.listSkills()).map((skill) => skill.name)).not.toContain("rolled back");

    const agent = await response(await createAgent(jsonRequest({ ...agentBody, name: "Concurrent agent", openclawRef: "openclaw:concurrent-agent" })));
    const skill = await response(await createSkill(jsonRequest({ name: "Concurrent skill", description: "Original", procedure: "Keep me." })));
    const workflow = await response(await createWorkflow(jsonRequest({
      name: "Concurrent workflow",
      description: "Original",
      graph: workflowGraph,
      isTemplate: false,
    })));

    const cases = [
      {
        resource: "agent",
        read: () => getAgent(new Request("http://orbitfactory.test"), context(agent.body.id)),
        patch: (expectedUpdatedAt: string, role: string) => patchAgent(jsonRequest({ role, expectedUpdatedAt }), context(agent.body.id)),
      },
      {
        resource: "skill",
        read: () => getSkill(new Request("http://orbitfactory.test"), context(skill.body.id)),
        patch: (expectedUpdatedAt: string, description: string) => patchSkill(jsonRequest({ description, expectedUpdatedAt }), context(skill.body.id)),
      },
      {
        resource: "workflow",
        read: () => getWorkflow(new Request("http://orbitfactory.test"), context(workflow.body.id)),
        patch: (expectedUpdatedAt: string, description: string) => patchWorkflow(jsonRequest({ description, expectedUpdatedAt }), context(workflow.body.id)),
      },
    ];

    for (const testCase of cases) {
      const [readerOne, readerTwo] = await Promise.all([testCase.read(), testCase.read()]);
      const [first, second] = await Promise.all([
        testCase.patch((await response(readerOne)).body.updatedAt, "first writer"),
        testCase.patch((await response(readerTwo)).body.updatedAt, "second writer"),
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 409]);
    }
  });

  it("FACT-22 reads bounded board, trail, durable agent state, and exact costs from PostgreSQL", async () => {
    const project = await pool.query("INSERT INTO projects (key, name, next_number) VALUES ('FACT', 'OrbitFactory', 4) RETURNING id");
    const workflow = await pool.query("INSERT INTO workflows (name, description, graph) VALUES ('Monitoring proof', 'FACT-22', '{}') RETURNING id");
    const [waitingAgent, workingAgent, zeroSpendAgent] = await Promise.all([
      pool.query(`INSERT INTO agents (name, role, system_prompt, model, guardrails, interaction_rules, memory) VALUES ('Question owner', 'worker', 'Ask when blocked.', 'test', '{"costLimit":0.3}', '{}', '{}') RETURNING id`),
      pool.query(`INSERT INTO agents (name, role, system_prompt, model, guardrails, interaction_rules, memory) VALUES ('Active owner', 'worker', 'Keep working.', 'test', '{"costLimit":1}', '{}', '{}') RETURNING id`),
      pool.query(`INSERT INTO agents (name, role, system_prompt, model, guardrails, interaction_rules, memory) VALUES ('No spend owner', 'worker', 'Remain visible without a cost event.', 'test', '{"costLimit":0.7}', '{}', '{}') RETURNING id`),
    ]);
    const run = await pool.query("INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec) VALUES ($1, 'running', 'ui', '{}') RETURNING id", [workflow.rows[0].id]);
    const [questionTicket, activeTicket] = await Promise.all([
      pool.query(`INSERT INTO tickets (number, identifier, project_id, run_id, title, status, assignee_agent_id) VALUES (1, 'FACT-1', $1, $2, 'Needs an answer', 'in_progress', $3) RETURNING id`, [project.rows[0].id, run.rows[0].id, waitingAgent.rows[0].id]),
      pool.query(`INSERT INTO tickets (number, identifier, project_id, run_id, title, status, assignee_agent_id) VALUES (2, 'FACT-2', $1, $2, 'Still executing', 'in_progress', $3) RETURNING id`, [project.rows[0].id, run.rows[0].id, workingAgent.rows[0].id]),
    ]);
    await pool.query(`INSERT INTO tickets (number, identifier, project_id, run_id, title, status, assignee_agent_id) VALUES (3, 'FACT-3', $1, $2, 'No cost yet', 'todo', $3)`, [project.rows[0].id, run.rows[0].id, zeroSpendAgent.rows[0].id]);
    await pool.query(`INSERT INTO messages (run_id, ticket_id, sender, recipient, type, payload, handoff_brief)
      VALUES ($1, $2, 'agent:' || $3, 'telegram:adam', 'question', '{"body":"Need a decision"}', 'Handoff before escalation'),
             ($1, $4, 'agent:' || $5, 'agent:next', 'output', '{"body":"Implementation update"}', 'Continue from this checkpoint'),
             ($1, $2, 'system:worker', 'agent:' || $3, 'system', '{"body":"Still waiting"}', NULL),
             ($1, NULL, 'telegram:adam', 'agent:' || $3, 'channel_inbound', '{"body":"Telegram reply"}', NULL)`, [run.rows[0].id, questionTicket.rows[0].id, waitingAgent.rows[0].id, activeTicket.rows[0].id, workingAgent.rows[0].id]);
    await pool.query(`INSERT INTO cost_events (run_id, agent_id, model, tokens_in, tokens_out, computed_cost)
      VALUES ($1, $2, 'test', 101, 11, 0.10000001), ($1, $2, 'test', 202, 22, 0.20000002), ($1, $3, 'test', 9, 3, 0.50000000)`, [run.rows[0].id, waitingAgent.rows[0].id, workingAgent.rows[0].id]);

    const all = await response(await getMonitoring(new Request("http://orbitfactory.test/api/monitoring")));
    expect(all.status).toBe(200);
    expect(all.body.board.map((ticket: { identifier: string }) => ticket.identifier).sort()).toEqual(["FACT-1", "FACT-2", "FACT-3"]);
    expect(all.body.trail.map((message: { type: string }) => message.type)).toEqual(["channel_inbound", "system", "output", "question"]);
    expect(all.body.agents.map((agent: { name: string; status: string }) => [agent.name, agent.status])).toEqual([["Active owner", "working"], ["No spend owner", "idle"], ["Question owner", "waiting-on-question"]]);
    expect(all.body.agentCosts).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentName: "Question owner", tokensIn: "303", tokensOut: "33", totalTokens: "336", totalCost: "0.30000003", costLimit: "0.3", overCostLimit: true }),
      expect.objectContaining({ agentName: "Active owner", totalCost: "0.50000000", costLimit: "1", overCostLimit: false }),
      expect.objectContaining({ agentName: "No spend owner", tokensIn: "0", tokensOut: "0", totalTokens: "0", totalCost: "0", costLimit: "0.7", overCostLimit: false }),
    ]));
    expect(all.body.runCosts).toEqual([expect.objectContaining({ runId: String(run.rows[0].id), tokensIn: "312", tokensOut: "36", totalTokens: "348", totalCost: "0.80000003" })]);

    const filtered = await response(await getMonitoring(new Request(`http://orbitfactory.test/api/monitoring?runId=${run.rows[0].id}&agentId=${waitingAgent.rows[0].id}&messageType=question`)));
    expect(filtered.status).toBe(200);
    expect(filtered.body.trail).toEqual([expect.objectContaining({ type: "question", ticketId: String(questionTicket.rows[0].id) })]);
    expect(filtered.body.agentCosts).toEqual([expect.objectContaining({ agentName: "Question owner", totalCost: "0.30000003" })]);
    expect(filtered.body.agentOptions.map((agent: { name: string }) => agent.name)).toEqual(["Active owner", "No spend owner", "Question owner"]);
    expect(filtered.body.runCosts).toEqual([expect.objectContaining({ totalCost: "0.30000003", totalTokens: "336" })]);
    const directQuestionSum = await pool.query("SELECT SUM(computed_cost)::text AS total_cost FROM cost_events WHERE run_id = $1 AND agent_id = $2", [run.rows[0].id, waitingAgent.rows[0].id]);
    expect(filtered.body.runCosts[0].totalCost).toBe(directQuestionSum.rows[0].total_cost);
    expect((await response(await getMonitoring(new Request("http://orbitfactory.test/api/monitoring?messageType=nope")))).status).toBe(400);

    const otherRun = await pool.query("INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec) VALUES ($1, 'running', 'ui', '{}') RETURNING id", [workflow.rows[0].id]);
    const otherAgent = await pool.query(`INSERT INTO agents (name, role, system_prompt, model, guardrails, interaction_rules, memory) VALUES ('Other run owner', 'worker', 'Do not leak into selected run.', 'test', '{}', '{}', '{}') RETURNING id`);
    await pool.query(`INSERT INTO tickets (number, identifier, project_id, run_id, title, status, assignee_agent_id) VALUES (4, 'FACT-4', $1, $2, 'Another run', 'in_progress', $3)`, [project.rows[0].id, otherRun.rows[0].id, otherAgent.rows[0].id]);
    const selectedRun = await response(await getMonitoring(new Request(`http://orbitfactory.test/api/monitoring?runId=${run.rows[0].id}`)));
    expect(selectedRun.body.agents.map((agent: { name: string }) => agent.name)).not.toContain("Other run owner");

    await pool.query("INSERT INTO messages (run_id, ticket_id, sender, recipient, type, payload) VALUES ($1, $2, 'telegram:adam', $3, 'answer', '{}')", [run.rows[0].id, questionTicket.rows[0].id, `agent:${waitingAgent.rows[0].id}`]);
    const resolved = await response(await getMonitoring(new Request("http://orbitfactory.test/api/monitoring")));
    expect(resolved.body.agents.find((agent: { name: string }) => agent.name === "Question owner")).toMatchObject({ status: "working" });
  });

  it("FACT-22 keeps every panel in one repeatable-read snapshot while another client commits", async () => {
    const project = await pool.query("INSERT INTO projects (key, name, next_number) VALUES ('SNAP', 'Snapshot proof', 3) RETURNING id");
    const workflow = await pool.query("INSERT INTO workflows (name, description, graph) VALUES ('Snapshot workflow', 'FACT-22', '{}') RETURNING id");
    const agent = await pool.query(`INSERT INTO agents (name, role, system_prompt, model, guardrails, interaction_rules, memory) VALUES ('Snapshot agent', 'worker', 'Read consistent data.', 'test', '{"costLimit":1}', '{}', '{}') RETURNING id`);
    const run = await pool.query("INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec) VALUES ($1, 'running', 'ui', '{}') RETURNING id", [workflow.rows[0].id]);
    await pool.query(`INSERT INTO tickets (number, identifier, project_id, run_id, title, status, assignee_agent_id) VALUES (1, 'SNAP-1', $1, $2, 'Before commit', 'in_progress', $3)`, [project.rows[0].id, run.rows[0].id, agent.rows[0].id]);
    let committed = false;
    const repository = new ControlPlaneRepository(pool, { afterMonitoringPanelRead: async (panel) => {
      if (panel !== "runs" || committed) return;
      committed = true;
      await pool.query(`INSERT INTO tickets (number, identifier, project_id, run_id, title, status, assignee_agent_id) VALUES (2, 'SNAP-2', $1, $2, 'Committed during read', 'in_progress', $3)`, [project.rows[0].id, run.rows[0].id, agent.rows[0].id]);
      await pool.query("INSERT INTO cost_events (run_id, agent_id, model, tokens_in, tokens_out, computed_cost) VALUES ($1, $2, 'test', 7, 5, 0.25000000)", [run.rows[0].id, agent.rows[0].id]);
    }});
    const consistent = await repository.getMonitoringSnapshot({ runId: String(run.rows[0].id), agentId: null, messageType: null });
    expect(committed).toBe(true);
    expect(consistent.board.map((ticket) => ticket.identifier)).toEqual(["SNAP-1"]);
    expect(consistent.runCosts).toEqual([expect.objectContaining({ totalCost: "0", totalTokens: "0" })]);
    const after = await new ControlPlaneRepository(pool).getMonitoringSnapshot({ runId: String(run.rows[0].id), agentId: null, messageType: null });
    expect(after.board.map((ticket) => ticket.identifier)).toContain("SNAP-2");
    expect(after.runCosts).toEqual([expect.objectContaining({ totalCost: "0.25000000", totalTokens: "12" })]);
  });

  it("FACT-22 exposes truncation metadata for capped board, agents, and agent costs", async () => {
    const project = await pool.query("INSERT INTO projects (key, name, next_number) VALUES ('CAP', 'Cap proof', 202) RETURNING id");
    const workflow = await pool.query("INSERT INTO workflows (name, description, graph) VALUES ('Cap workflow', 'FACT-22', '{}') RETURNING id");
    const run = await pool.query("INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec) VALUES ($1, 'running', 'ui', '{}') RETURNING id", [workflow.rows[0].id]);
    await pool.query(`INSERT INTO agents (name, role, system_prompt, model, guardrails, interaction_rules, memory) SELECT 'Cap agent ' || n, 'worker', 'Bounded result proof.', 'test', '{"costLimit":1}', '{}', '{}' FROM generate_series(1, 201) AS n`);
    await pool.query(`INSERT INTO tickets (number, identifier, project_id, run_id, title, status, assignee_agent_id) SELECT n, 'CAP-' || n, $1, $2, 'Cap ticket ' || n, 'in_progress', agent.id FROM generate_series(1, 201) AS n JOIN agents AS agent ON agent.name = 'Cap agent ' || n`, [project.rows[0].id, run.rows[0].id]);
    const capped = await new ControlPlaneRepository(pool).getMonitoringSnapshot({ runId: String(run.rows[0].id), agentId: null, messageType: null });
    expect(capped.board).toHaveLength(200);
    expect(capped.agents).toHaveLength(200);
    expect(capped.agentCosts).toHaveLength(200);
    expect(capped).toMatchObject({ boardTruncated: true, agentsTruncated: true, agentCostsTruncated: true, trailTruncated: false });
  });

  it("FACT-22 marks per-run costs truncated when the retained run set exceeds 100", async () => {
    const workflow = await pool.query("INSERT INTO workflows (name, description, graph) VALUES ('Run cap workflow', 'FACT-22', '{}') RETURNING id");
    const agent = await pool.query("INSERT INTO agents (name, role, system_prompt, model, guardrails, interaction_rules, memory) VALUES ('Run cap agent', 'worker', 'Prove retained-run cost truncation.', 'test', '{}', '{}', '{}') RETURNING id");
    await pool.query("INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec) SELECT $1, 'running', 'ui', '{}' FROM generate_series(1, 101)", [workflow.rows[0].id]);
    await pool.query("INSERT INTO cost_events (run_id, agent_id, model, tokens_in, tokens_out, computed_cost) SELECT run.id, $2, 'test', 1, 2, 0.01000000 FROM workflow_runs AS run WHERE run.workflow_id = $1", [workflow.rows[0].id, agent.rows[0].id]);

    const capped = await new ControlPlaneRepository(pool).getMonitoringSnapshot({ runId: null, agentId: null, messageType: null });

    expect(capped.runs).toHaveLength(100);
    expect(capped.runCosts).toHaveLength(100);
    expect(capped).toMatchObject({ runsTruncated: true, runCostsTruncated: true });
  });
});
