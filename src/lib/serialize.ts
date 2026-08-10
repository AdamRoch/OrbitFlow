import { eq } from "drizzle-orm";
import type { DB } from "./db";
import * as s from "./db/schema";
import type { IssueDTO, LabelDTO } from "./types";
import { SYSTEM_LABEL_COLOR, SYSTEM_LABEL_NAME } from "./config";

/**
 * Convert an issue row (plus its labels + blocker edges) into the canonical
 * JSON shape returned by every API read. better-sqlite3 is a synchronous
 * driver, so these helpers are synchronous too — which also lets us call them
 * safely inside `db.transaction()`.
 *
 * We fetch labels and blocker ids per issue; the tracker is single-user with a
 * small dataset, so per-issue queries are fine and keep the code simple.
 *
 * The "Ready for Agent" label is *derived*, not stored: when an issue is on the
 * frontier (status `todo`, every blocker `done`) it is injected here as a
 * virtual label. See `src/lib/config.ts`.
 */
export function toIssueDTO(db: DB, issue: s.IssueRow): IssueDTO {
  const labels = db
    .select({
      id: s.labels.id,
      name: s.labels.name,
      color: s.labels.color,
    })
    .from(s.issueLabels)
    .innerJoin(s.labels, eq(s.issueLabels.labelId, s.labels.id))
    .where(eq(s.issueLabels.issueId, issue.id))
    .all()
    // Defensive: older DBs may have a stored row named like the derived system
    // label (it was a seed default). The virtual injection below is the single
    // source of truth for that label, so drop any stale persisted copy here.
    .filter((l) => l.name.toLowerCase() !== SYSTEM_LABEL_NAME);

  // Fetch blocker ids together with their statuses so we can compute
  // readiness in the same pass. `ready` mirrors getFrontier: `todo` with every
  // blocker `done`. (`canceled` does not satisfy the edge.)
  const blockerRows = db
    .select({
      blockerIssueId: s.dependencies.blockerIssueId,
      blockerStatus: s.issues.status,
    })
    .from(s.dependencies)
    .innerJoin(s.issues, eq(s.dependencies.blockerIssueId, s.issues.id))
    .where(eq(s.dependencies.blockedIssueId, issue.id))
    .all();
  const blockerIssueIds = blockerRows
    .map((r) => r.blockerIssueId)
    .sort((a, b) => a - b);

  const ready =
    issue.status === "todo" && blockerRows.every((r) => r.blockerStatus === "done");

  // Fetch the issue's Q&A history, oldest first. `status` is derived from
  // `answeredAt`: null ⇒ open (asked, awaiting an answer); non-null ⇒ answered.
  // The full history is embedded so an answering model reads prior exchanges
  // as context, and an implementing agent checks for answers with one GET.
  const labelDTOs = labels as LabelDTO[];

  // Inject the virtual "Ready for Agent" label when the issue is ready. Use a
  // stable synthetic id (0) that no persisted label can collide with.
  if (ready) {
    labelDTOs.push({
      id: 0,
      name: SYSTEM_LABEL_NAME,
      color: SYSTEM_LABEL_COLOR,
    });
  }

  // Deterministic ordering so responses don't jitter across reads.
  labelDTOs.sort((a, b) => a.name.localeCompare(b.name));

  return {
    id: issue.id,
    identifier: issue.identifier,
    number: issue.number,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority as s.Priority,
    labels: labelDTOs,
    blockerIssueIds,
    ready,
    createdAt: new Date(issue.createdAt).toISOString(),
    updatedAt: new Date(issue.updatedAt).toISOString(),
  };
}

/** Serialize many issues in one pass. */
export function toIssueDTOs(db: DB, issues: s.IssueRow[]): IssueDTO[] {
  return issues.map((i) => toIssueDTO(db, i));
}
