import {
  sqliteTable,
  integer,
  text,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

// ---- Controlled vocabularies (source of truth for status/priority) ----
// Declared first so the table below can reference them in the enum helper.

export const issueStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "done",
  "canceled",
] as const;
export type IssueStatus = (typeof issueStatuses)[number];

export const priorities = [0, 1, 2, 3, 4] as const;
export type Priority = (typeof priorities)[number];

export const priorityLabels: Record<Priority, string> = {
  0: "No priority",
  1: "Low",
  2: "Medium",
  3: "High",
  4: "Urgent",
};

/**
 * Logical schema for the tracker.
 *
 *   projects        — internal scope used to allocate stable identifiers
 *   issues          — the core ticket entity
 *   labels          — triage vocabulary (name + color); global across projects
 *   issue_labels    — many-to-many between issues and labels
 *   dependencies    — directed edge "blocker blocks blocked" (same-project only)
 *
 * Identifier scheme: `FACT-<number>`. The number is allocated atomically from
 * `projects.next_number` and never reused.
 *
 * Dependency direction is fixed: a row (blocker=A, blocked=B) reads
 * "A blocks B" / "B is blocked by A". The frontier query for B checks that
 * every A where (A, B) exists has status = done. Edges are only ever created
 * between issues in the same project (no cross-project leakage).
 */
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // The identifier prefix, e.g. "LIN" or "OEMR". Stored uppercased; alphabetic
  // only (no digits) so it can't collide with the numeric part of an identifier.
  // Unique case-insensitively (enforced on create; stored uppercase so the
  // UNIQUE constraint is sufficient).
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  // Per-project high-water counter for issue numbers. Using a stored counter
  // (instead of MAX(number)+1) guarantees numbers are never reused, even after
  // the highest-numbered issue is deleted. Atomically incremented at create.
  nextNumber: integer("next_number").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

export const issues = sqliteTable(
  "issues",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Ticket number; never reused and separate from the surrogate id.
    number: integer("number").notNull(),
    // Stored as `FACT-${number}` for stable external references.
    identifier: text("identifier").notNull().unique(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status", { enum: issueStatuses }).notNull().default("backlog"),
    priority: integer("priority").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    // The internal scope allocates one monotonic ticket sequence.
    uniqueIndex("issues_project_number_unique").on(t.projectId, t.number),
    index("idx_issues_project").on(t.projectId),
  ],
);

export const labels = sqliteTable("labels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  color: text("color").notNull(),
});

export const issueLabels = sqliteTable(
  "issue_labels",
  {
    issueId: integer("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    labelId: integer("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.labelId] })],
);

export const dependencies = sqliteTable(
  "dependencies",
  {
    // The issue that must reach `done`.
    blockerIssueId: integer("blocker_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    // The issue that is held back until its blockers are done.
    blockedIssueId: integer("blocked_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.blockerIssueId, t.blockedIssueId] })],
);

export type IssueRow = typeof issues.$inferSelect;
export type LabelRow = typeof labels.$inferSelect;
export type DependencyRow = typeof dependencies.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
