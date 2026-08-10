import { getDb } from "@/lib/db";
import { claimIssue } from "@/lib/domain";
import {
  conflict,
  handleError,
  notFound,
  ok,
  requireProject,
  RouteContext,
} from "@/lib/api";

/**
 * POST /api/issues/:id/claim
 * Atomically move a `todo` issue to `in_progress`.
 *   - todo (no undone blockers) → in_progress: 200
 *   - in_progress → in_progress: 200 (idempotent)
 *   - todo with undone blockers: 409
 *   - backlog/done/canceled: 409
 *   - missing: 404
 */
export async function POST(_req: Request, ctx: RouteContext) {
  try {
    const db = getDb();
    const project = requireProject(db);
    const { id } = await ctx.params;
    const result = claimIssue(db, project, id);
    if (!result.ok) {
      if (result.reason === "not_found") return notFound("issue not found");
      if (result.reason === "blocked")
        return conflict("issue is blocked by unfinished work", "blocked");
      return conflict(
        `cannot claim an issue with status "${result.status}"`,
        "not_claimable",
      );
    }
    return ok(result.issue);
  } catch (err) {
    return handleError(err);
  }
}
