/**
 * Prefix for stable ticket identifiers in the temporary SQLite foundation.
 * FACT-6 owns the production PostgreSQL schema.
 */
export const PROJECT_PREFIX =
  (process.env.ORBITFACTORY_PREFIX?.trim() || "FACT").toUpperCase();

/** Suggested defaults seeded into a fresh DB (see db#seedDefaultsIfNeeded). */
export const SEED_DEFAULT_LABELS =
  process.env.ORBITFACTORY_SEED !== "false";

/**
 * The "Ready for Agent" label is special: it is *derived* from an issue's
 * state (status `todo` and every blocker `done`), not assigned by hand. We
 * inject it virtually at read time (never persist it in `issue_labels`), so
 * it is always truthful with no write-path fan-out. Because it isn't stored,
 * any attempt to set it on an issue is a no-op, and it cannot be deleted.
 *
 * The name/color mirror the seed default so existing DBs render identically.
 */
export const SYSTEM_LABEL_NAME = "ready-for-agent";
export const SYSTEM_LABEL_COLOR = "#22c55e";
