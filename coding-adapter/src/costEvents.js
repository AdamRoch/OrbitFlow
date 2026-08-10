import { PersistenceError } from "./errors.js";

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
];

export function createCostEventStore({ pool } = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new PersistenceError("a PostgreSQL pool is required for cost attribution");
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

  return { recordDelegation };
}

function validateUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw new PersistenceError("coding-tool usage is malformed");
  }
  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new PersistenceError("coding-tool usage is malformed");
    }
  }
}

function normalizeId(value) {
  const text = typeof value === "bigint" ? value.toString() : String(value ?? "");
  if (!/^[1-9]\d*$/.test(text)) throw new PersistenceError("run and agent ids must be positive integers");
  return text;
}
