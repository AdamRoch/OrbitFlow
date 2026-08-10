import {
  and,
  desc,
  asc,
  eq,
  inArray,
  ne,
} from "drizzle-orm";
import type { DB } from "./db";
import { nextIssueNumber } from "./db";
import * as s from "./db/schema";
import type { IssueStatus, Priority, LabelRow, ProjectRow } from "./db/schema";
import { toIssueDTO, toIssueDTOs } from "./serialize";
import type { IssueDTO, LabelDTO } from "./types";
import { ValidationError } from "./validate";
import { identifierFor, resolveIssue } from "./identifiers";
import { SYSTEM_LABEL_NAME } from "./config";

/** Case-insensitive check for the derived "Ready for Agent" label name. */
function isSystemLabel(name: string): boolean {
  return name.toLowerCase() === SYSTEM_LABEL_NAME;
}

/**
 * The domain layer. Every operation the UI and API need goes through here so
 * the rules (frontier, cycle prevention, claim semantics, identifier
 * assignment, label cascade, project scope) live in exactly one place.
 *
 * better-sqlite3 is a synchronous driver, so every function here is sync —
 * which lets us safely run multi-statement work inside `db.transaction()`.
 * All functions take an explicit `db` so tests can pass a per-test database.
 *
 * Most functions also take an explicit `project: ProjectRow` — the active
 * scope. Identifier resolution is gated against `project.key` so a request
 * scoped to one project cannot read or mutate another project's ticket by
 * guessing its identifier (the "no cross-project leakage" rule).
 */

// ----------------------------------------------------------------------------
// Issues — reads
// ----------------------------------------------------------------------------

export interface ListFilters {
  status?: IssueStatus;
  priority?: Priority;
  label?: string; // by name
}

const DEFAULT_ORDER = [desc(s.issues.priority), desc(s.issues.createdAt)];

/**
 * List issues scoped to a project with optional filters.
 * Default order: priority desc, created desc.
 */
export function listIssues(
  db: DB,
  project: ProjectRow,
  filters: ListFilters = {},
): IssueDTO[] {
  const conds = [eq(s.issues.projectId, project.id)];
  if (filters.status) conds.push(eq(s.issues.status, filters.status));
  if (filters.priority !== undefined)
    conds.push(eq(s.issues.priority, filters.priority));

  let rows: s.IssueRow[];
  if (filters.label && isSystemLabel(filters.label)) {
    // The "Ready for Agent" label isn't stored — it's derived. Filtering by it
    // means "on the frontier": status `todo` with every blocker `done`.
    rows = db
      .select()
      .from(s.issues)
      .where(and(...conds))
      .orderBy(...DEFAULT_ORDER)
      .all();
    rows = rows.filter(
      (r) => r.status === "todo" && isOnFrontier(db, r.id),
    );
  } else if (filters.label) {
    // Find issue ids that carry a label by this name, then intersect with
    // status/priority conditions. Labels are global across projects.
    const matched = db
      .select({ issueId: s.issueLabels.issueId })
      .from(s.issueLabels)
      .innerJoin(s.labels, eq(s.issueLabels.labelId, s.labels.id))
      .where(eq(s.labels.name, filters.label))
      .all();
    if (matched.length === 0) return [];
    const ids = matched.map((m) => m.issueId);
    rows = db
      .select()
      .from(s.issues)
      .where(and(inArray(s.issues.id, ids), ...conds))
      .orderBy(...DEFAULT_ORDER)
      .all();
  } else {
    rows = db
      .select()
      .from(s.issues)
      .where(and(...conds))
      .orderBy(...DEFAULT_ORDER)
      .all();
  }

  return toIssueDTOs(db, rows);
}

/**
 * Get a single issue by id or identifier within a project scope. Returns null
 * if not found, including when the identifier's prefix doesn't match the
 * project's key (preventing cross-project leakage).
 */
export function getIssue(
  db: DB,
  project: ProjectRow,
  idOrIdentifier: string | number,
): IssueDTO | null {
  const row = resolveIssue(db, project, idOrIdentifier);
  if (!row) return null;
  return toIssueDTO(db, row);
}

// ----------------------------------------------------------------------------
// Frontier — the product
// ----------------------------------------------------------------------------

/**
 * The frontier for a project: issues that are `todo` AND whose every blocker
 * is `done`.
 *
 * Semantics (load-bearing):
 *  - `todo` status is required. `backlog` is never on the frontier.
 *  - A blocker satisfies the edge only when its status is `done`.
 *    `canceled` does NOT satisfy — the dependent must be re-pointed.
 *  - An issue with no blockers is on the frontier iff it is `todo`.
 *  - Order: priority desc, then created asc (oldest first within a priority,
 *    so a long-waiting ticket wins ties over a fresh one).
 *
 * Implementation: collect `todo` issues whose blocker set contains any
 * non-`done` issue, then subtract from all `todo` issues. Cheaper than
 * per-issue traversal and reads cleanly in SQL.
 */
export function getFrontier(db: DB, project: ProjectRow): IssueDTO[] {
  const todoIssues = db
    .select()
    .from(s.issues)
    .where(
      and(eq(s.issues.status, "todo"), eq(s.issues.projectId, project.id)),
    )
    .all();

  if (todoIssues.length === 0) return [];

  const todoIds = todoIssues.map((i) => i.id);

  // Issue ids that have at least one blocker which is NOT done.
  const blockedByUndone = db
    .select({ blockedId: s.dependencies.blockedIssueId })
    .from(s.dependencies)
    .innerJoin(s.issues, eq(s.dependencies.blockerIssueId, s.issues.id))
    .where(
      and(
        inArray(s.dependencies.blockedIssueId, todoIds),
        ne(s.issues.status, "done"),
      ),
    )
    .all();
  const notReady = new Set(blockedByUndone.map((r) => r.blockedId));

  const frontierRows = todoIssues.filter((i) => !notReady.has(i.id));

  // Order: priority desc, then created asc (oldest first at same priority).
  frontierRows.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.createdAt - b.createdAt;
  });

  return toIssueDTOs(db, frontierRows);
}

/**
 * Is this issue currently on the frontier? Mirrors the logic of `getFrontier`
 * for a single issue. Exposed for tests / UI hints.
 */
export function isOnFrontier(db: DB, issueId: number): boolean {
  const issue = db.select().from(s.issues).where(eq(s.issues.id, issueId)).get();
  if (!issue || issue.status !== "todo") return false;
  const blockers = db
    .select({ status: s.issues.status })
    .from(s.dependencies)
    .innerJoin(s.issues, eq(s.dependencies.blockerIssueId, s.issues.id))
    .where(eq(s.dependencies.blockedIssueId, issueId))
    .all();
  return blockers.every((b) => b.status === "done");
}

// ----------------------------------------------------------------------------
// Issues — writes
// ----------------------------------------------------------------------------

export interface CreateIssueArgs {
  title: string;
  description: string | null;
  status?: IssueStatus;
  priority?: Priority;
  labelNames?: string[];
}

/**
 * Create an issue in a project, assigning the next per-project number
 * atomically. The identifier is `${project.key}-${number}`.
 */
export function createIssue(
  db: DB,
  project: ProjectRow,
  args: CreateIssueArgs,
): IssueDTO {
  return db.transaction((tx) => {
    const now = Date.now();
    const number = nextIssueNumber(tx, project.id);
    const identifier = identifierFor(project.key, number);
    const status: IssueStatus = args.status ?? "backlog";
    const priority: Priority = args.priority ?? 0;

    const result = tx
      .insert(s.issues)
      .values({
        number,
        identifier,
        projectId: project.id,
        title: args.title,
        description: args.description,
        status,
        priority,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    // Attach any requested labels by name. Unknown names are silently skipped
    // on create — POST /issues doesn't promise strict label validation; the
    // strict contract is PUT /issues/:id/labels. The derived "Ready for Agent"
    // label is never stored, so it's silently ignored here too.
    if (args.labelNames && args.labelNames.length > 0) {
      const existing = tx.select().from(s.labels).all();
      const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l]));
      for (const name of args.labelNames) {
        if (isSystemLabel(name)) continue;
        const label = byName.get(name.toLowerCase());
        if (label) {
          tx.insert(s.issueLabels)
            .values({ issueId: result.id, labelId: label.id })
            .run();
        }
      }
    }

    return toIssueDTO(tx, result);
  });
}

export interface UpdateIssueArgs {
  title?: string;
  description?: string | null;
  status?: IssueStatus;
  priority?: Priority;
}

/** Patch an issue. Only provided fields are touched; updatedAt bumps. */
export function updateIssue(
  db: DB,
  project: ProjectRow,
  idOrIdentifier: string | number,
  args: UpdateIssueArgs,
): IssueDTO | null {
  const existing = resolveIssue(db, project, idOrIdentifier);
  if (!existing) return null;

  const patch: Partial<s.IssueRow> = { updatedAt: Date.now() };
  if (args.title !== undefined) patch.title = args.title;
  if (args.description !== undefined) patch.description = args.description;
  if (args.status !== undefined) patch.status = args.status;
  if (args.priority !== undefined) patch.priority = args.priority;

  db.update(s.issues).set(patch).where(eq(s.issues.id, existing.id)).run();
  const updated = db
    .select()
    .from(s.issues)
    .where(eq(s.issues.id, existing.id))
    .get()!;
  return toIssueDTO(db, updated);
}

/** Delete an issue; cascade removes its label + dependency rows. */
export function deleteIssue(
  db: DB,
  project: ProjectRow,
  idOrIdentifier: string | number,
): boolean {
  const existing = resolveIssue(db, project, idOrIdentifier);
  if (!existing) return false;
  db.delete(s.issues).where(eq(s.issues.id, existing.id)).run();
  return true;
}

// ----------------------------------------------------------------------------
// Claiming
// ----------------------------------------------------------------------------

export type ClaimResult =
  | { ok: true; issue: IssueDTO }
  | { ok: false; reason: "not_found" | "not_claimable"; status?: IssueStatus }
  | { ok: false; reason: "blocked" };

/**
 * Atomically move a `todo` issue to `in_progress`.
 *  - todo → in_progress: success (only if not blocked)
 *  - in_progress → in_progress: idempotent success (already claimed)
 *  - todo with undone blockers: 409 blocked
 *  - backlog/done/canceled: 409 not_claimable
 *  - missing: not_found
 */
export function claimIssue(
  db: DB,
  project: ProjectRow,
  idOrIdentifier: string | number,
): ClaimResult {
  const existing = resolveIssue(db, project, idOrIdentifier);
  if (!existing) return { ok: false, reason: "not_found" };

  if (existing.status === "in_progress") {
    const updated = db
      .select()
      .from(s.issues)
      .where(eq(s.issues.id, existing.id))
      .get()!;
    return { ok: true, issue: toIssueDTO(db, updated) };
  }

  if (existing.status === "todo") {
    if (!isOnFrontier(db, existing.id)) {
      return { ok: false, reason: "blocked" };
    }
    const now = Date.now();
    db.update(s.issues)
      .set({ status: "in_progress", updatedAt: now })
      .where(eq(s.issues.id, existing.id))
      .run();
    const updated = db
      .select()
      .from(s.issues)
      .where(eq(s.issues.id, existing.id))
      .get()!;
    return { ok: true, issue: toIssueDTO(db, updated) };
  }

  return { ok: false, reason: "not_claimable", status: existing.status };
}

// ----------------------------------------------------------------------------
// Labels
// ----------------------------------------------------------------------------

/**
 * List all labels, sorted by name. A stored label sharing the derived system
 * label's name (a leftover from older seed data) is excluded: that label is
 * virtual and never managed here, so surfacing a stale stored row would be
 * misleading. Labels are global across projects in the lean view-only model.
 */
export function listLabels(db: DB): LabelDTO[] {
  const rows = db.select().from(s.labels).orderBy(asc(s.labels.name)).all();
  return (rows as LabelDTO[]).filter(
    (l) => l.name.toLowerCase() !== SYSTEM_LABEL_NAME,
  );
}

export interface CreateLabelArgs {
  name: string;
  color: string;
}

/** Create a label. Throws ValidationError on duplicate or reserved name. */
export function createLabel(db: DB, args: CreateLabelArgs): LabelDTO {
  // The derived "Ready for Agent" label is reserved: it's injected virtually
  // at read time, so a persisted label of the same name would be shadowed and
  // confuse readers.
  if (isSystemLabel(args.name)) {
    throw new ValidationError(
      `label "${SYSTEM_LABEL_NAME}" is reserved (managed automatically)`,
      "reserved",
    );
  }
  const existing = db
    .select()
    .from(s.labels)
    .where(eq(s.labels.name, args.name))
    .all();
  if (existing.length > 0) {
    throw new ValidationError(`label "${args.name}" already exists`, "duplicate");
  }
  const row = db
    .insert(s.labels)
    .values({ name: args.name, color: args.color })
    .returning()
    .get();
  return row as LabelDTO;
}

/** Delete a label; cascade removes it from all issues (issues are kept). */
export function deleteLabel(db: DB, id: number): boolean {
  const existing = db.select().from(s.labels).where(eq(s.labels.id, id)).get();
  if (!existing) return false;
  db.delete(s.labels).where(eq(s.labels.id, id)).run();
  return true;
}

// ----------------------------------------------------------------------------
// Issue ↔ labels (full replacement per the PUT contract)
// ----------------------------------------------------------------------------

/**
 * Replace an issue's labels with the set named in `labelNames`. Unknown names
 * are an error (400) — this endpoint does not create labels on the fly.
 */
export function setIssueLabels(
  db: DB,
  project: ProjectRow,
  idOrIdentifier: string | number,
  labelNames: string[],
): IssueDTO | null {
  const issue = resolveIssue(db, project, idOrIdentifier);
  if (!issue) return null;

  const all = db.select().from(s.labels).all();
  const byName = new Map(all.map((l) => [l.name.toLowerCase(), l]));

  const resolved: LabelRow[] = [];
  const unknown: string[] = [];
  const seen = new Set<number>();
  for (const name of labelNames) {
    // The derived "Ready for Agent" label isn't stored; silently ignore it
    // rather than treat it as an unknown label (it reads back as present/absent
    // based on the issue's state regardless of what the caller submits).
    if (isSystemLabel(name)) continue;
    const label = byName.get(name.toLowerCase());
    if (!label) unknown.push(name);
    else if (!seen.has(label.id)) {
      seen.add(label.id);
      resolved.push(label);
    }
  }
  if (unknown.length > 0) {
    throw new ValidationError(
      `unknown label name(s): ${unknown.join(", ")}`,
      "unknown_label",
    );
  }

  db.transaction((tx) => {
    tx.delete(s.issueLabels).where(eq(s.issueLabels.issueId, issue.id)).run();
    for (const label of resolved) {
      tx.insert(s.issueLabels)
        .values({ issueId: issue.id, labelId: label.id })
        .run();
    }
  });

  const updated = db
    .select()
    .from(s.issues)
    .where(eq(s.issues.id, issue.id))
    .get()!;
  return toIssueDTO(db, updated);
}

// ----------------------------------------------------------------------------
// Dependencies (blockers)
// ----------------------------------------------------------------------------

export interface DependencyEdge {
  blockerIssueId: number;
  blockedIssueId: number;
}

/** Return the blocker issues for a given issue (scoped to its project). */
export function getBlockers(
  db: DB,
  project: ProjectRow,
  idOrIdentifier: string | number,
): IssueDTO[] | null {
  const issue = resolveIssue(db, project, idOrIdentifier);
  if (!issue) return null;
  const rows = db
    .select()
    .from(s.issues)
    .where(
      inArray(
        s.issues.id,
        db
          .select({ id: s.dependencies.blockerIssueId })
          .from(s.dependencies)
          .where(eq(s.dependencies.blockedIssueId, issue.id)),
      ),
    )
    .all();
  return toIssueDTOs(db, rows);
}

/** Return the issues this issue is blocking (its dependents). */
export function getBlockedBy(
  db: DB,
  project: ProjectRow,
  idOrIdentifier: string | number,
): IssueDTO[] | null {
  const issue = resolveIssue(db, project, idOrIdentifier);
  if (!issue) return null;
  const rows = db
    .select()
    .from(s.issues)
    .where(
      inArray(
        s.issues.id,
        db
          .select({ id: s.dependencies.blockedIssueId })
          .from(s.dependencies)
          .where(eq(s.dependencies.blockerIssueId, issue.id)),
      ),
    )
    .all();
  return toIssueDTOs(db, rows);
}

/**
 * Add a "blocker blocks blocked" edge. Rejects:
 *  - either issue missing → returns null (caller maps to 404)
 *  - the issues live in different projects → ValidationError (cross-project
 *    edges are out of scope for the lean view-only model)
 *  - self-edge (blocker === blocked) → ValidationError (400)
 *  - would-create-cycle → ValidationError (400)
 *
 * Both endpoints are resolved against the same `project` scope: an issue in
 * project LIN cannot block an issue in project OEMR, even by id.
 *
 * Cycle check: adding edge `blocker → blocked` (blocker blocks blocked) is
 * unsafe iff `blocker` is already transitively blocked by `blocked` — i.e.
 * following the "is blocked by" chain from blocker we reach blocked. That is
 * equivalent to: can we reach `blocked` from `blocker` by following "blocks"
 * edges? Walk the "blocks" relation from `blocked` and see if we hit blocker.
 */
export function addBlocker(
  db: DB,
  project: ProjectRow,
  blockedIdOrIdent: string | number,
  blockerIdOrIdent: string | number,
): DependencyEdge | null {
  const blocked = resolveIssue(db, project, blockedIdOrIdent);
  if (!blocked) return null;
  const blocker = resolveIssue(db, project, blockerIdOrIdent);
  if (!blocker) return null;

  if (blocker.id === blocked.id) {
    throw new ValidationError("an issue cannot block itself", "self_edge");
  }

  // Lean view-only model: deps live within a project. Both endpoints already
  // resolved against the same scope, so this is structurally true; the check
  // is a defensive guard against future cross-project resolution paths.
  if (blocker.projectId !== blocked.projectId) {
    throw new ValidationError(
      "cross-project dependencies are not supported",
      "cross_project",
    );
  }

  // Cycle: does adding blocker→blocked close a loop? It would iff `blocked`
  // already (transitively) blocks `blocker`. Walk "blocks" edges from `blocked`
  // and see whether we reach `blocker`.
  if (reaches(db, blocked.id, blocker.id)) {
    throw new ValidationError(
      "adding this dependency would create a cycle",
      "cycle",
    );
  }

  // Idempotent insert: if the edge already exists, just return it.
  const existing = db
    .select()
    .from(s.dependencies)
    .where(
      and(
        eq(s.dependencies.blockerIssueId, blocker.id),
        eq(s.dependencies.blockedIssueId, blocked.id),
      ),
    )
    .get();
  if (existing) {
    return { blockerIssueId: blocker.id, blockedIssueId: blocked.id };
  }

  db.insert(s.dependencies)
    .values({ blockerIssueId: blocker.id, blockedIssueId: blocked.id })
    .run();
  return { blockerIssueId: blocker.id, blockedIssueId: blocked.id };
}

/** Remove a blocker edge. Returns false if the edge didn't exist. */
export function removeBlocker(
  db: DB,
  project: ProjectRow,
  blockedIdOrIdent: string | number,
  blockerIdOrIdent: string | number,
): boolean | null {
  const blocked = resolveIssue(db, project, blockedIdOrIdent);
  if (!blocked) return null;
  const blocker = resolveIssue(db, project, blockerIdOrIdent);
  if (!blocker) return null;

  const existing = db
    .select()
    .from(s.dependencies)
    .where(
      and(
        eq(s.dependencies.blockerIssueId, blocker.id),
        eq(s.dependencies.blockedIssueId, blocked.id),
      ),
    )
    .get();
  if (!existing) return false;

  db.delete(s.dependencies)
    .where(
      and(
        eq(s.dependencies.blockerIssueId, blocker.id),
        eq(s.dependencies.blockedIssueId, blocked.id),
      ),
    )
    .run();
  return true;
}

/**
 * Does `from` reach `to` by following "blocks" edges (from is a blocker of…)?
 * neighbors(from) = issues that `from` blocks = rows with blocker_issue_id=from.
 *
 * Used for cycle detection: adding blocker→blocked is unsafe if `blocked`
 * already reaches `blocker` through the existing blocker graph.
 */
function reaches(db: DB, from: number, to: number): boolean {
  const visited = new Set<number>();
  const stack = [from];
  while (stack.length) {
    const current = stack.pop()!;
    if (current === to) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const next = db
      .select({ id: s.dependencies.blockedIssueId })
      .from(s.dependencies)
      .where(eq(s.dependencies.blockerIssueId, current))
      .all();
    for (const n of next) stack.push(n.id);
  }
  return false;
}
