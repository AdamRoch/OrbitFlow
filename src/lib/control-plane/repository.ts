import { types } from "pg";
import type { Pool, PoolClient } from "pg";
import type {
  AgentDTO,
  CreateAgentInput,
  CreateSkillInput,
  CreateWorkflowInput,
  JsonObject,
  SkillDTO,
  UpdateAgentInput,
  UpdateResult,
  UpdateSkillInput,
  UpdateWorkflowInput,
  WorkflowDTO,
} from "./types";

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

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  // `pg` preserves timestamptz precision as text for optimistic concurrency.
  // PostgreSQL emits `YYYY-MM-DD HH:MM:SS.ffffff+00`; ISO-8601 uses `T`.
  return String(value).replace(" ", "T");
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

async function one<T>(queryable: Queryable, text: string, values: unknown[] = []): Promise<T | null> {
  const result = await queryable.query(text, values);
  return result.rows[0] ? (result.rows[0] as T) : null;
}

export class ControlPlaneRepository {
  constructor(private readonly pool: Pool) {}

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
    if (input.expectedUpdatedAt) {
      values.push(input.expectedUpdatedAt);
      where += ` AND updated_at = $${values.length}::timestamptz`;
    }
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
    if (input.expectedUpdatedAt) {
      values.push(input.expectedUpdatedAt);
      where += ` AND updated_at = $${values.length}::timestamptz`;
    }
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
    if (input.expectedUpdatedAt) {
      values.push(input.expectedUpdatedAt);
      where += ` AND updated_at = $${values.length}::timestamptz`;
    }
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
}
