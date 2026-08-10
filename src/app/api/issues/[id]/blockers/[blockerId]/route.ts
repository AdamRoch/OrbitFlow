import { getDb } from "@/lib/db";
import { removeBlocker } from "@/lib/domain";
import {
  handleError,
  noContent,
  notFound,
  requireProject,
  RouteContext,
} from "@/lib/api";

type Context = RouteContext<{ id: string; blockerId: string }>;

/**
 * DELETE /api/issues/:id/blockers/:blockerId
 *   Remove the edge "blockerId blocks :id". 204 on success, 404 if either the
 *   issue or the edge is missing. Resolution is project-scoped.
 */
export async function DELETE(_req: Request, ctx: Context) {
  try {
    const db = getDb();
    const project = requireProject(db);
    const { id, blockerId } = await ctx.params;
    const result = removeBlocker(db, project, id, blockerId);
    if (result === null) return notFound("issue not found");
    if (result === false) return notFound("dependency edge not found");
    return noContent();
  } catch (err) {
    return handleError(err);
  }
}
