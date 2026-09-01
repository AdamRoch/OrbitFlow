import { types } from "pg";
import type { Pool, PoolClient } from "pg";
import type {
  AgentDTO,
  CreateAgentInput,
  CreateAgentScheduleInput,
  CreateSkillInput,
  CreateWorkflowInput,
  JsonObject,
  ScheduleDTO,
  SkillDTO,
  UpdateAgentInput,
  UpdateScheduleInput,
  UpdateResult,
  UpdateSkillInput,
  UpdateWorkflowInput,
  WorkflowDTO,
  MonitoringAgentDTO,
  MonitoringFilters,
  MonitoringMessageDTO,
  MonitoringSnapshot,
} from "./types";
import { ValidationError } from "../validate";
import { parseOpenClawModelCatalog } from "../runtime/openclaw-model-catalog.mjs";
import openClawConfig from "../../../docker/openclaw/openclaw.json";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;
type Row = Record<string, unknown>;

// PostgreSQL timestamps are our optimistic-lock version values. Keep the raw
// microsecond precision instead of letting the driver's Date conversion lose it.
types.setTypeParser(1184, (value) => value);

const AGENT_SELECT = `
  SELECT a.id, a.name, a.role, a.system_prompt, a.model, a.coding_tool_enabled,
         a.guardrails, a.interaction_rules, a.channel_binding, a.memory,
         a.openclaw_ref, a.created_at, a.updated_at,
         COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', s.id, 'name', s.name, 'description', s.description,
               'procedure', s.procedure, 'createdAt', s.created_at,
               'updatedAt', s.updated_at
             ) ORDER BY s.name, s.id
           ) FILTER (WHERE s.id IS NOT NULL),
           '[]'::jsonb
         ) AS skills
  FROM agents a
  LEFT JOIN agent_skills assn ON assn.agent_id = a.id
  LEFT JOIN skills s ON s.id = assn.skill_id
`;

const modelCatalog = parseOpenClawModelCatalog(openClawConfig);

async function requireAvailableModel(model: string): Promise<void> {
  if (!modelCatalog.availableModels.includes(model)) {
    throw new ValidationError(
      `model "${model}" is unavailable in the OpenClaw runtime catalog; available models: ${modelCatalog.availableModels.join(", ")}`,
      "unavailable_model",
    );
  }
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  // `pg` preserves timestamptz precision as text for optimistic concurrency.
  // PostgreSQL emits `YYYY-MM-DD HH:MM:SS.ffffff+00`; ISO-8601 uses `T`
  // and a colon in the UTC offset. Return a value clients can send back as
  // the mandatory PATCH precondition without losing microsecond precision.
  return String(value).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
}

function object(value: unknown): JsonObject {
  return value as JsonObject;
}

function skillFromRow(row: Row): SkillDTO {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    procedure: String(row.procedure),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function skillFromEmbedded(value: Row): SkillDTO {
  return {
    id: String(value.id),
    name: String(value.name),
    description: String(value.description),
    procedure: String(value.procedure),
    createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt),
  };
}

function agentFromRow(row: Row): AgentDTO {
  return {
    id: String(row.id),
    name: String(row.name),
    role: String(row.role),
    systemPrompt: String(row.system_prompt),
    model: String(row.model),
    codingToolEnabled: Boolean(row.coding_tool_enabled),
    guardrails: object(row.guardrails),
    interactionRules: object(row.interaction_rules),
    channelBinding: row.channel_binding === null ? null : object(row.channel_binding),
    memory: object(row.memory),
    openclawRef: row.openclaw_ref === null ? null : String(row.openclaw_ref),
    skills: (row.skills as Row[]).map(skillFromEmbedded),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function workflowFromRow(row: Row): WorkflowDTO {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    graph: object(row.graph),
    isTemplate: Boolean(row.is_template),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function scheduleFromRow(row: Row): ScheduleDTO {
  return {
    id: String(row.id),
    cronExpression: String(row.cron_expression),
    workflowId: row.workflow_id === null ? null : String(row.workflow_id),
    agentId: row.agent_id === null ? null : String(row.agent_id),
    taskPrompt: row.task_prompt === null ? null : String(row.task_prompt),
    enabled: Boolean(row.enabled),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const MONITORING_LIMIT = 200;
const RUN_LIMIT = 100;
const LOG_LIMIT = 3;

export interface ControlPlaneRepositoryOptions {
  /** Test seam for proving that all monitoring panels share one database snapshot. */
  afterMonitoringPanelRead?: (panel: "runs" | "board" | "trail" | "agents" | "run-costs" | "agent-costs") => Promise<void>;
}

function monitoringMessageFromRow(row: Row): MonitoringMessageDTO {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    ticketId: row.ticket_id === null ? null : String(row.ticket_id),
    sequenceNumber: String(row.sequence_number),
    sender: String(row.sender),
    recipient: String(row.recipient),
    type: String(row.type),
    payload: object(row.payload),
    handoffBrief: row.handoff_brief === null ? null : String(row.handoff_brief),
    createdAt: iso(row.created_at),
  };
}

function monitoringChannelFromBinding(binding: unknown): MonitoringAgentDTO["channel"] {
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) return null;
  const { provider, chatId } = object(binding);
  if (typeof provider !== "string" || provider === "") return null;
  return { provider, chatId: typeof chatId === "string" && chatId !== "" ? chatId : null };
}

function monitoringAgentFromRow(row: Row): MonitoringAgentDTO {
  const logs = (row.logs as Row[]).slice(0, LOG_LIMIT).map(monitoringMessageFromRow);
  return {
    id: String(row.id),
    name: String(row.name),
    role: String(row.role),
    channel: monitoringChannelFromBinding(row.channel_binding),
    status: String(row.status) as MonitoringAgentDTO["status"],
    currentTask: row.task_id === null
      ? null
      : {
          id: String(row.task_id),
          identifier: String(row.task_identifier),
          title: String(row.task_title),
          runId: String(row.task_run_id),
        },
    logs,
    logsTruncated: (row.logs as Row[]).length > LOG_LIMIT,
  };
}

async function one<T>(queryable: Queryable, text: string, values: unknown[] = []): Promise<T | null> {
  const result = await queryable.query(text, values);
  return result.rows[0] ? (result.rows[0] as T) : null;
}

export class ControlPlaneRepository {
  constructor(private readonly pool: Pool, private readonly options: ControlPlaneRepositoryOptions = {}) {}

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listAgents(): Promise<AgentDTO[]> {
    const result = await this.pool.query(`${AGENT_SELECT} GROUP BY a.id ORDER BY a.name, a.id`);
    return result.rows.map((row) => agentFromRow(row));
  }

  async getAgent(id: string, queryable: Queryable = this.pool): Promise<AgentDTO | null> {
    const row = await one<Row>(queryable, `${AGENT_SELECT} WHERE a.id = $1 GROUP BY a.id`, [id]);
    return row ? agentFromRow(row) : null;
  }

  async createAgent(input: CreateAgentInput): Promise<AgentDTO> {
    await requireAvailableModel(input.model);
    const row = await one<Row>(
      this.pool,
      `INSERT INTO agents (
         name, role, system_prompt, model, coding_tool_enabled, guardrails,
         interaction_rules, channel_binding, memory, openclaw_ref
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10)
       RETURNING id`,
      [
        input.name, input.role, input.systemPrompt, input.model, input.codingToolEnabled,
        JSON.stringify(input.guardrails), JSON.stringify(input.interactionRules),
        input.channelBinding === null ? null : JSON.stringify(input.channelBinding),
        JSON.stringify(input.memory), input.openclawRef,
      ],
    );
    return (await this.getAgent(String(row!.id)))!;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<UpdateResult<AgentDTO>> {
    if (input.model !== undefined) await requireAvailableModel(input.model);
    const assignments: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown, json = false) => {
      values.push(json && value !== null ? JSON.stringify(value) : value);
      assignments.push(`${column} = $${values.length}${json ? "::jsonb" : ""}`);
    };
    if (input.name !== undefined) add("name", input.name);
    if (input.role !== undefined) add("role", input.role);
    if (input.systemPrompt !== undefined) add("system_prompt", input.systemPrompt);
    if (input.model !== undefined) add("model", input.model);
    if (input.codingToolEnabled !== undefined) add("coding_tool_enabled", input.codingToolEnabled);
    if (input.guardrails !== undefined) add("guardrails", input.guardrails, true);
    if (input.interactionRules !== undefined) add("interaction_rules", input.interactionRules, true);
    if (input.channelBinding !== undefined) add("channel_binding", input.channelBinding, true);
    if (input.memory !== undefined) add("memory", input.memory, true);
    if (input.openclawRef !== undefined) add("openclaw_ref", input.openclawRef);
    values.push(id);
    let where = `id = $${values.length}`;
    values.push(input.expectedUpdatedAt);
    where += ` AND updated_at = $${values.length}::timestamptz`;
    const updated = await one<Row>(
      this.pool,
      `UPDATE agents SET ${assignments.join(", ")}, updated_at = now()
       WHERE ${where} RETURNING id`,
      values,
    );
    if (updated) return { kind: "updated", value: (await this.getAgent(String(updated.id)))! };
    return (await this.getAgent(id)) ? { kind: "conflict" } : { kind: "not_found" };
  }

  async deleteAgent(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM agents WHERE id = $1", [id]);
    return result.rowCount === 1;
  }

  async listSchedulesForAgent(agentId: string): Promise<ScheduleDTO[]> {
    const result = await this.pool.query(
      "SELECT * FROM schedules WHERE agent_id = $1 ORDER BY id",
      [agentId],
    );
    return result.rows.map((row) => scheduleFromRow(row));
  }

  async createAgentSchedule(agentId: string, input: CreateAgentScheduleInput): Promise<ScheduleDTO | null> {
    return this.transaction(async (client) => {
      if (!(await this.getAgent(agentId, client))) return null;
      const row = await one<Row>(
        client,
        `INSERT INTO schedules (cron_expression, agent_id, task_prompt, enabled)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [input.cronExpression, agentId, input.taskPrompt, input.enabled],
      );
      return scheduleFromRow(row!);
    });
  }

  async getSchedule(id: string): Promise<ScheduleDTO | null> {
    const row = await one<Row>(this.pool, "SELECT * FROM schedules WHERE id = $1", [id]);
    return row ? scheduleFromRow(row) : null;
  }

  /** FACT-19 may mutate only schedules that target an agent, never workflows. */
  async updateAgentSchedule(id: string, input: UpdateScheduleInput): Promise<UpdateResult<ScheduleDTO>> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };
    if (input.cronExpression !== undefined) add("cron_expression", input.cronExpression);
    if (input.taskPrompt !== undefined) add("task_prompt", input.taskPrompt);
    if (input.enabled !== undefined) add("enabled", input.enabled);
    values.push(id);
    let where = `id = $${values.length} AND agent_id IS NOT NULL`;
    values.push(input.expectedUpdatedAt);
    where += ` AND updated_at = $${values.length}::timestamptz`;
    const row = await one<Row>(
      this.pool,
      `UPDATE schedules SET ${assignments.join(", ")}, updated_at = now()
       WHERE ${where} RETURNING *`,
      values,
    );
    if (row) return { kind: "updated", value: scheduleFromRow(row) };
    return (await this.getAgentSchedule(id)) ? { kind: "conflict" } : { kind: "not_found" };
  }

  async getAgentSchedule(id: string): Promise<ScheduleDTO | null> {
    const row = await one<Row>(this.pool, "SELECT * FROM schedules WHERE id = $1 AND agent_id IS NOT NULL", [id]);
    return row ? scheduleFromRow(row) : null;
  }

  async deleteAgentSchedule(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM schedules WHERE id = $1 AND agent_id IS NOT NULL", [id]);
    return result.rowCount === 1;
  }

  async listSkills(): Promise<SkillDTO[]> {
    const result = await this.pool.query("SELECT * FROM skills ORDER BY name, id");
    return result.rows.map((row) => skillFromRow(row));
  }

  async getSkill(id: string, queryable: Queryable = this.pool): Promise<SkillDTO | null> {
    const row = await one<Row>(queryable, "SELECT * FROM skills WHERE id = $1", [id]);
    return row ? skillFromRow(row) : null;
  }

  async createSkill(input: CreateSkillInput): Promise<SkillDTO> {
    const row = await one<Row>(
      this.pool,
      "INSERT INTO skills (name, description, procedure) VALUES ($1, $2, $3) RETURNING *",
      [input.name, input.description, input.procedure],
    );
    return skillFromRow(row!);
  }

  async updateSkill(id: string, input: UpdateSkillInput): Promise<UpdateResult<SkillDTO>> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };
    if (input.name !== undefined) add("name", input.name);
    if (input.description !== undefined) add("description", input.description);
    if (input.procedure !== undefined) add("procedure", input.procedure);
    values.push(id);
    let where = `id = $${values.length}`;
    values.push(input.expectedUpdatedAt);
    where += ` AND updated_at = $${values.length}::timestamptz`;
    const row = await one<Row>(
      this.pool,
      `UPDATE skills SET ${assignments.join(", ")}, updated_at = now() WHERE ${where} RETURNING *`,
      values,
    );
    if (row) return { kind: "updated", value: skillFromRow(row) };
    return (await this.getSkill(id)) ? { kind: "conflict" } : { kind: "not_found" };
  }

  async deleteSkill(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM skills WHERE id = $1", [id]);
    return result.rowCount === 1;
  }

  async attachSkill(agentId: string, skillId: string): Promise<"attached" | "agent_not_found" | "skill_not_found"> {
    return this.transaction(async (client) => {
      if (!(await this.getAgent(agentId, client))) return "agent_not_found";
      if (!(await this.getSkill(skillId, client))) return "skill_not_found";
      await client.query(
        "INSERT INTO agent_skills (agent_id, skill_id) VALUES ($1, $2) ON CONFLICT (agent_id, skill_id) DO NOTHING",
        [agentId, skillId],
      );
      return "attached";
    });
  }

  async detachSkill(agentId: string, skillId: string): Promise<"detached" | "agent_not_found" | "skill_not_found"> {
    return this.transaction(async (client) => {
      if (!(await this.getAgent(agentId, client))) return "agent_not_found";
      if (!(await this.getSkill(skillId, client))) return "skill_not_found";
      await client.query("DELETE FROM agent_skills WHERE agent_id = $1 AND skill_id = $2", [agentId, skillId]);
      return "detached";
    });
  }

  async listWorkflows(): Promise<WorkflowDTO[]> {
    const result = await this.pool.query("SELECT * FROM workflows ORDER BY name, id");
    return result.rows.map((row) => workflowFromRow(row));
  }

  async getWorkflow(id: string): Promise<WorkflowDTO | null> {
    const row = await one<Row>(this.pool, "SELECT * FROM workflows WHERE id = $1", [id]);
    return row ? workflowFromRow(row) : null;
  }

  async createWorkflow(input: CreateWorkflowInput): Promise<WorkflowDTO> {
    const row = await one<Row>(
      this.pool,
      `INSERT INTO workflows (name, description, graph, is_template)
       VALUES ($1, $2, $3::jsonb, $4) RETURNING *`,
      [input.name, input.description, JSON.stringify(input.graph), input.isTemplate],
    );
    return workflowFromRow(row!);
  }

  async updateWorkflow(id: string, input: UpdateWorkflowInput): Promise<UpdateResult<WorkflowDTO>> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown, json = false) => {
      values.push(json ? JSON.stringify(value) : value);
      assignments.push(`${column} = $${values.length}${json ? "::jsonb" : ""}`);
    };
    if (input.name !== undefined) add("name", input.name);
    if (input.description !== undefined) add("description", input.description);
    if (input.graph !== undefined) add("graph", input.graph, true);
    if (input.isTemplate !== undefined) add("is_template", input.isTemplate);
    values.push(id);
    let where = `id = $${values.length}`;
    values.push(input.expectedUpdatedAt);
    where += ` AND updated_at = $${values.length}::timestamptz`;
    const row = await one<Row>(
      this.pool,
      `UPDATE workflows SET ${assignments.join(", ")}, updated_at = now() WHERE ${where} RETURNING *`,
      values,
    );
    if (row) return { kind: "updated", value: workflowFromRow(row) };
    return (await this.getWorkflow(id)) ? { kind: "conflict" } : { kind: "not_found" };
  }

  async deleteWorkflow(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM workflows WHERE id = $1", [id]);
    return result.rowCount === 1;
  }

  /**
   * A single bounded read model for FACT-22. It derives every displayed value
   * from PostgreSQL tables; notifications only tell the browser to call this
   * again. Numeric values deliberately remain PostgreSQL strings so costs and
   * int8 token counts do not lose precision in JavaScript.
   */
  async getMonitoringSnapshot(filters: MonitoringFilters): Promise<MonitoringSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const runs = await client.query<Row>(
        `SELECT run.id, workflow.name AS workflow_name, run.status, run.trigger_type,
                run.created_at, run.workflow_version, run.retry_of_run_id,
                run.retry_blocked_reason
         FROM workflow_runs AS run JOIN workflows AS workflow ON workflow.id = run.workflow_id
         WHERE ($1::bigint IS NULL OR run.id = $1::bigint)
         ORDER BY run.created_at DESC, run.id DESC LIMIT $2`,
        [filters.runId, RUN_LIMIT + 1],
      );
      await this.options.afterMonitoringPanelRead?.("runs");
      const retainedRuns = runs.rows.slice(0, RUN_LIMIT);
      const runsTruncated = runs.rows.length > RUN_LIMIT;
      const runIds = retainedRuns.map((row) => String(row.id));
      const scopedRuns = runIds.length > 0 ? runIds : ["-1"];

      const board = await client.query<Row>(
        `SELECT ticket.id, ticket.run_id, ticket.identifier, ticket.title, ticket.status, ticket.priority,
                ticket.assignee_agent_id, agent.name AS assignee_name, ticket.updated_at,
                count(question.id)::int AS question_count,
                count(question.id) FILTER (WHERE question.status = 'pending')::int AS pending_question_count
         FROM tickets AS ticket LEFT JOIN agents AS agent ON agent.id = ticket.assignee_agent_id
         LEFT JOIN workflow_questions AS question ON question.ticket_id = ticket.id
         WHERE ticket.run_id = ANY($1::bigint[])
           AND ($2::bigint IS NULL OR ticket.assignee_agent_id = $2::bigint)
         GROUP BY ticket.id, agent.name
         ORDER BY ticket.priority DESC, ticket.updated_at DESC, ticket.id DESC LIMIT $3`,
        [scopedRuns, filters.agentId, MONITORING_LIMIT + 1],
      );
      await this.options.afterMonitoringPanelRead?.("board");
      const pendingQuestions = await client.query<Row>(
        `SELECT question.*, ticket.identifier AS ticket_identifier
         FROM workflow_questions AS question
         JOIN workflow_runs AS run ON run.id = question.run_id
         LEFT JOIN tickets AS ticket ON ticket.id = question.ticket_id
         WHERE question.run_id = ANY($1::bigint[]) AND question.status = 'pending'
           AND run.status IN ('running', 'paused')
           AND ($2::bigint IS NULL OR question.target_agent_id = $2::bigint
             OR ticket.assignee_agent_id = $2::bigint)
         ORDER BY question.created_at, question.id LIMIT $3`,
        [scopedRuns, filters.agentId, MONITORING_LIMIT + 1],
      );
      const messages = await client.query<Row>(
        `SELECT message.id, message.run_id, message.ticket_id, message.sequence_number, message.sender,
                message.recipient, message.type, message.payload, message.handoff_brief, message.created_at
         FROM messages AS message LEFT JOIN tickets AS ticket ON ticket.id = message.ticket_id
         WHERE message.run_id = ANY($1::bigint[])
           AND ($2::bigint IS NULL OR ticket.assignee_agent_id = $2::bigint
             OR message.sender = 'agent:' || $2::text OR message.recipient = 'agent:' || $2::text)
           AND ($3::message_type IS NULL OR message.type = $3::message_type)
         ORDER BY message.created_at DESC, message.id DESC LIMIT $4`,
        [scopedRuns, filters.agentId, filters.messageType, MONITORING_LIMIT + 1],
      );
      await this.options.afterMonitoringPanelRead?.("trail");
      const agents = await client.query<Row>(
        `WITH participating_agents AS (
           SELECT DISTINCT ticket.assignee_agent_id AS agent_id FROM tickets AS ticket
             WHERE ticket.run_id = ANY($1::bigint[]) AND ticket.assignee_agent_id IS NOT NULL
           UNION
           SELECT DISTINCT cost.agent_id FROM cost_events AS cost WHERE cost.run_id = ANY($1::bigint[])
         )
         SELECT agent.id, agent.name, agent.role, agent.channel_binding, task.id AS task_id, task.identifier AS task_identifier,
                task.title AS task_title, task.run_id AS task_run_id,
                CASE WHEN unanswered_question.id IS NOT NULL THEN 'waiting-on-question'
                     WHEN task.id IS NOT NULL AND task.status = 'in_progress' AND task.run_status = 'running' THEN 'working'
                     ELSE 'idle' END AS status, COALESCE(logs.messages, '[]'::jsonb) AS logs
         FROM participating_agents AS participant JOIN agents AS agent ON agent.id = participant.agent_id
         LEFT JOIN LATERAL (
           SELECT ticket.id, ticket.identifier, ticket.title, ticket.run_id, ticket.status, run.status AS run_status
           FROM tickets AS ticket JOIN workflow_runs AS run ON run.id = ticket.run_id
           WHERE ticket.assignee_agent_id = agent.id AND ticket.run_id = ANY($1::bigint[])
             AND ticket.status IN ('todo', 'in_progress')
           ORDER BY (ticket.status = 'in_progress') DESC, ticket.updated_at DESC, ticket.id DESC LIMIT 1
         ) AS task ON true
         LEFT JOIN LATERAL (
           SELECT question.id FROM workflow_questions AS question
           WHERE question.ticket_id = task.id AND question.status = 'pending'
           ORDER BY question.created_at DESC, question.id DESC LIMIT 1
         ) AS unanswered_question ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(to_jsonb(log_row) ORDER BY log_row.sequence_number DESC) AS messages FROM (
             SELECT message.id, message.run_id, message.ticket_id, message.sequence_number, message.sender,
                    message.recipient, message.type, message.payload, message.handoff_brief, message.created_at
             FROM messages AS message WHERE message.ticket_id = task.id
             ORDER BY message.sequence_number DESC LIMIT $2
           ) AS log_row
         ) AS logs ON true
         WHERE ($3::bigint IS NULL OR agent.id = $3::bigint)
         ORDER BY agent.name, agent.id LIMIT $4`,
        [scopedRuns, LOG_LIMIT + 1, filters.agentId, MONITORING_LIMIT + 1],
      );
      await this.options.afterMonitoringPanelRead?.("agents");
      const agentOptions = await client.query<Row>(
        `WITH participating_agents AS (
           SELECT DISTINCT ticket.assignee_agent_id AS agent_id FROM tickets AS ticket
             WHERE ticket.run_id = ANY($1::bigint[]) AND ticket.assignee_agent_id IS NOT NULL
           UNION SELECT DISTINCT cost.agent_id FROM cost_events AS cost WHERE cost.run_id = ANY($1::bigint[])
         )
         SELECT agent.id, agent.name FROM participating_agents AS participant
         JOIN agents AS agent ON agent.id = participant.agent_id
         ORDER BY agent.name, agent.id LIMIT $2`,
        [scopedRuns, MONITORING_LIMIT + 1],
      );
      const runCosts = await client.query<Row>(
        `SELECT run.id AS run_id, workflow.name AS workflow_name,
                COALESCE(SUM(cost.tokens_in), 0)::text AS tokens_in, COALESCE(SUM(cost.tokens_out), 0)::text AS tokens_out,
                COALESCE(SUM(cost.tokens_in + cost.tokens_out), 0)::text AS total_tokens,
                COALESCE(SUM(cost.computed_cost), 0)::text AS total_cost
         FROM workflow_runs AS run JOIN workflows AS workflow ON workflow.id = run.workflow_id
         LEFT JOIN cost_events AS cost ON cost.run_id = run.id AND ($2::bigint IS NULL OR cost.agent_id = $2::bigint)
         WHERE run.id = ANY($1::bigint[]) GROUP BY run.id, workflow.name, run.created_at
         ORDER BY run.created_at DESC, run.id DESC LIMIT $3`,
        [scopedRuns, filters.agentId, RUN_LIMIT + 1],
      );
      await this.options.afterMonitoringPanelRead?.("run-costs");
      const agentCosts = await client.query<Row>(
        `WITH participating_agents AS (
           SELECT DISTINCT ticket.run_id, ticket.assignee_agent_id AS agent_id FROM tickets AS ticket
             WHERE ticket.run_id = ANY($1::bigint[]) AND ticket.assignee_agent_id IS NOT NULL
           UNION
           SELECT DISTINCT cost.run_id, cost.agent_id FROM cost_events AS cost WHERE cost.run_id = ANY($1::bigint[])
         )
         SELECT participant.run_id, agent.id AS agent_id, agent.name AS agent_name, workflow.name AS workflow_name,
                COALESCE(SUM(cost.tokens_in), 0)::text AS tokens_in, COALESCE(SUM(cost.tokens_out), 0)::text AS tokens_out,
                COALESCE(SUM(cost.tokens_in + cost.tokens_out), 0)::text AS total_tokens,
                COALESCE(SUM(cost.computed_cost), 0)::text AS total_cost,
                CASE WHEN jsonb_typeof(agent.guardrails -> 'costLimit') = 'number' THEN agent.guardrails ->> 'costLimit' ELSE NULL END AS cost_limit,
                CASE WHEN jsonb_typeof(agent.guardrails -> 'costLimit') = 'number'
                  THEN COALESCE(SUM(cost.computed_cost), 0) > (agent.guardrails ->> 'costLimit')::numeric ELSE false END AS over_cost_limit
         FROM participating_agents AS participant JOIN agents AS agent ON agent.id = participant.agent_id
         JOIN workflow_runs AS run ON run.id = participant.run_id JOIN workflows AS workflow ON workflow.id = run.workflow_id
         LEFT JOIN cost_events AS cost ON cost.run_id = participant.run_id AND cost.agent_id = agent.id
         WHERE ($2::bigint IS NULL OR agent.id = $2::bigint)
         GROUP BY participant.run_id, run.created_at, agent.id, agent.name, agent.guardrails, workflow.name
         ORDER BY run.created_at DESC, participant.run_id DESC, agent.name, agent.id LIMIT $3`,
        [scopedRuns, filters.agentId, MONITORING_LIMIT + 1],
      );
      await this.options.afterMonitoringPanelRead?.("agent-costs");
      await client.query("COMMIT");

      return {
      filters,
      readAt: new Date().toISOString(),
      runs: retainedRuns.map((row) => ({
        id: String(row.id), workflowName: String(row.workflow_name), status: String(row.status),
        triggerType: String(row.trigger_type), createdAt: iso(row.created_at),
        workflowVersion: iso(row.workflow_version),
        retryOfRunId: row.retry_of_run_id === null ? null : String(row.retry_of_run_id),
        retryBlockedReason: row.retry_blocked_reason === null ? null : String(row.retry_blocked_reason),
      })),
      board: board.rows.slice(0, MONITORING_LIMIT).map((row) => ({
        id: String(row.id), runId: row.run_id === null ? null : String(row.run_id),
        identifier: String(row.identifier), title: String(row.title), status: String(row.status),
        priority: Number(row.priority), assigneeAgentId: row.assignee_agent_id === null ? null : String(row.assignee_agent_id),
        assigneeName: row.assignee_name === null ? null : String(row.assignee_name), updatedAt: iso(row.updated_at),
        questionCount: Number(row.question_count), pendingQuestionCount: Number(row.pending_question_count),
      })),
      pendingQuestions: pendingQuestions.rows.slice(0, MONITORING_LIMIT).map((row) => ({
        id: String(row.id), runId: String(row.run_id), ticketId: row.ticket_id === null ? null : String(row.ticket_id),
        ticketIdentifier: row.ticket_identifier === null ? null : String(row.ticket_identifier),
        kind: row.kind as "question" | "approval", boundary: row.boundary as "worker" | "before" | "after",
        route: row.route as "agent" | "human-via-channel" | "human-via-UI", questionText: String(row.question_text),
        createdAt: iso(row.created_at),
      })),
      trail: messages.rows.slice(0, MONITORING_LIMIT).map(monitoringMessageFromRow),
      trailTruncated: messages.rows.length > MONITORING_LIMIT,
      agents: agents.rows.slice(0, MONITORING_LIMIT).map(monitoringAgentFromRow),
      agentOptions: agentOptions.rows.slice(0, MONITORING_LIMIT).map((row) => ({ id: String(row.id), name: String(row.name) })),
      runCosts: runCosts.rows.slice(0, RUN_LIMIT).map((row) => ({
        runId: String(row.run_id), workflowName: String(row.workflow_name), tokensIn: String(row.tokens_in),
        tokensOut: String(row.tokens_out), totalTokens: String(row.total_tokens), totalCost: String(row.total_cost),
      })),
      agentCosts: agentCosts.rows.slice(0, MONITORING_LIMIT).map((row) => ({
        runId: String(row.run_id), workflowName: String(row.workflow_name), agentId: String(row.agent_id),
        agentName: String(row.agent_name), tokensIn: String(row.tokens_in), tokensOut: String(row.tokens_out),
        totalTokens: String(row.total_tokens), totalCost: String(row.total_cost),
        costLimit: row.cost_limit === null ? null : String(row.cost_limit),
        overCostLimit: Boolean(row.over_cost_limit),
      })),
      runsTruncated,
      boardTruncated: board.rows.length > MONITORING_LIMIT,
      agentsTruncated: agents.rows.length > MONITORING_LIMIT,
      // runCosts are scoped to the same retained runs. When that run set is
      // capped, its otherwise-full aggregate list is still incomplete.
      runCostsTruncated: runsTruncated || runCosts.rows.length > RUN_LIMIT,
      agentCostsTruncated: agentCosts.rows.length > MONITORING_LIMIT,
      agentOptionsTruncated: agentOptions.rows.length > MONITORING_LIMIT,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
