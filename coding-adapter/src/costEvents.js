import { PersistenceError } from "./errors.js";
import {
  isDatabaseCost,
  isDatabaseTokenCount,
  TOKEN_USAGE_FIELDS,
} from "./usage.js";

export function createCostEventStore({ pool } = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new PersistenceError("a PostgreSQL pool is required for cost attribution");
  }

  async function verifyAttribution({ runId, agentId }) {
    const normalizedRunId = normalizeId(runId);
    const normalizedAgentId = normalizeId(agentId);
    try {
      const result = await pool.query(
        `SELECT 1
         FROM workflow_runs AS run
         CROSS JOIN agents AS agent
         WHERE run.id = $1 AND agent.id = $2`,
        [normalizedRunId, normalizedAgentId],
      );
      if (result.rowCount !== 1) throw new Error("attribution target is missing");
    } catch {
      throw new PersistenceError("coding-tool run or agent does not exist");
    }
  }

  async function recordDelegation({ runId, agentId, model, usage }) {
    const normalizedRunId = normalizeId(runId);
    const normalizedAgentId = normalizeId(agentId);
    if (typeof model !== "string" || model.trim() === "") {
      throw new PersistenceError("coding-tool model is required for cost attribution");
    }
    validateUsage(usage);

    try {
      const result = await pool.query(
        `INSERT INTO cost_events (
           run_id,
           agent_id,
           model,
           tokens_in,
           tokens_out,
           computed_cost,
           cache_read_tokens,
           cache_write_tokens
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id::text AS id`,
        [
          normalizedRunId,
          normalizedAgentId,
          model,
          usage.inputTokens,
          usage.outputTokens,
          usage.costUsd,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
        ],
      );
      if (result.rowCount !== 1) throw new Error("insert returned no row");
      return result.rows[0].id;
    } catch {
      throw new PersistenceError();
    }
  }

  return { verifyAttribution, recordDelegation };
}

function validateUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw new PersistenceError("coding-tool usage is malformed");
  }
  for (const field of TOKEN_USAGE_FIELDS) {
    const value = usage[field];
    if (value !== null && !isDatabaseTokenCount(value)) {
      throw new PersistenceError("coding-tool usage is malformed");
    }
  }
  if (usage.costUsd !== null && !isDatabaseCost(usage.costUsd)) {
    throw new PersistenceError("coding-tool usage is malformed");
  }
}

function normalizeId(value) {
  const text = typeof value === "bigint" ? value.toString() : String(value ?? "");
  if (!/^[1-9]\d*$/.test(text)) throw new PersistenceError("run and agent ids must be positive integers");
  return text;
}
