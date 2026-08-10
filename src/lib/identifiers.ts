import { and, eq } from "drizzle-orm";
import type { DB } from "./db";
import * as s from "./db/schema";

/**
 * Resolve a route `:id` param — which the contract says may be either the
 * numeric surrogate `id` or the `identifier` string (e.g. `LIN-42`) — to the
 * issue row, scoped to a specific project. Returns `null` when not found OR
 * when the identifier's prefix doesn't match the project's key (preventing
 * cross-project leakage by identifier).
 *
 * `project` is the active scope. Identifier-form lookups require the prefix to
 * match `project.key` (case-insensitively); numeric lookups require the row to
 * belong to `project.id`. This is the load-bearing "no cross-project leakage"
 * gate: an attacker who knows another project's identifier can't read or
 * mutate it through this project's scope.
 */
export function resolveIssue(
  db: DB,
  project: s.ProjectRow,
  idOrIdentifier: string | number,
): s.IssueRow | null {
  // Numeric form: pure integer → match on id, scoped to the project.
  if (typeof idOrIdentifier === "number") {
    return (
      db
        .select()
        .from(s.issues)
        .where(
          and(eq(s.issues.id, idOrIdentifier), eq(s.issues.projectId, project.id)),
        )
        .get() ?? null
    );
  }

  const str = String(idOrIdentifier).trim();

  // Pure number string → surrogate id, scoped to the project.
  if (/^\d+$/.test(str)) {
    const n = Number(str);
    return (
      db
        .select()
        .from(s.issues)
        .where(and(eq(s.issues.id, n), eq(s.issues.projectId, project.id)))
        .get() ?? null
    );
  }

  // Identifier form: PREFIX-NUMBER. The prefix MUST match the project's key
  // (case-insensitive on the alphabetic part). A mismatch is treated as
  // not-found rather than leaked: `LIN-42` requested against project `OEMR`
  // returns null even if `LIN-42` exists in another project.
  const match = str.match(/^([A-Za-z]+)-(\d+)$/);
  if (match) {
    const [, prefix, num] = match;
    if (prefix.toUpperCase() !== project.key.toUpperCase()) return null;
    const exact = `${project.key}-${num}`;
    return (
      db
        .select()
        .from(s.issues)
        .where(
          and(
            eq(s.issues.identifier, exact),
            eq(s.issues.projectId, project.id),
          ),
        )
        .get() ?? null
    );
  }

  return null;
}

/**
 * Build the identifier string for an issue in a given project. The project key
 * IS the identifier prefix.
 */
export function identifierFor(projectKey: string, number: number): string {
  return `${projectKey}-${number}`;
}
