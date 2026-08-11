/**
 * FACT-23 guardrails parsing. The control plane stores guardrails as free-form
 * JSONB on `agents.guardrails` and inside `workflow_runs.spec.guardrails`; the
 * editor UI owns write-time validation. Readers here fail open on malformed
 * values (treated as unconfigured) so a hand-edited row can never crash the
 * engine, matching the FACT-22 monitoring read of `costLimit`.
 */
export interface AgentGuardrails {
  /** USD ceiling on this agent's spend inside one run; null means no ceiling. */
  costLimit: number | null;
  /** Maximum wakes per trailing one-minute window; null means no limit. */
  rateLimitPerMinute: number | null;
  /** Action names the platform tool surface must reject for this agent. */
  blockedActions: string[];
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseAgentGuardrails(value: unknown): AgentGuardrails {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { costLimit: null, rateLimitPerMinute: null, blockedActions: [] };
  }
  const guardrails = value as Record<string, unknown>;
  const rateLimit =
    guardrails.rateLimit !== null &&
    typeof guardrails.rateLimit === "object" &&
    !Array.isArray(guardrails.rateLimit)
      ? (guardrails.rateLimit as Record<string, unknown>)
      : null;
  const blockedActions = Array.isArray(guardrails.blockedActions)
    ? guardrails.blockedActions
        .filter((action): action is string => typeof action === "string")
        .map((action) => action.trim())
        .filter((action) => action !== "")
    : [];
  return {
    costLimit: nonNegativeNumber(guardrails.costLimit),
    rateLimitPerMinute: rateLimit === null ? null : nonNegativeNumber(rateLimit.perMinute),
    blockedActions,
  };
}

/** A run-level ceiling lives in the immutable run spec at `guardrails.costLimit`. */
export function parseRunCostLimit(spec: unknown): number | null {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return null;
  const guardrails = (spec as Record<string, unknown>).guardrails;
  if (guardrails === null || typeof guardrails !== "object" || Array.isArray(guardrails)) {
    return null;
  }
  return nonNegativeNumber((guardrails as Record<string, unknown>).costLimit);
}
