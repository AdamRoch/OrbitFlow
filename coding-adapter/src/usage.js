export const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
export const POSTGRES_NUMERIC_18_8_LIMIT = 10_000_000_000;

export const TOKEN_USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
];

export function isDatabaseTokenCount(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    BigInt(value) <= POSTGRES_BIGINT_MAX
  );
}

export function isDatabaseCost(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value < POSTGRES_NUMERIC_18_8_LIMIT
  );
}

export function addTokenCounts(left, right) {
  if (!isDatabaseTokenCount(left) || !isDatabaseTokenCount(right)) return null;
  const total = left + right;
  return isDatabaseTokenCount(total) ? total : null;
}

export function addCosts(left, right) {
  if (!isDatabaseCost(left) || !isDatabaseCost(right)) return null;
  const total = left + right;
  return isDatabaseCost(total) ? total : null;
}
