import { getDb } from "@/lib/db";
import { deleteLabel } from "@/lib/domain";
import { handleError, noContent, notFound, RouteContext } from "@/lib/api";

/**
 * DELETE /api/labels/:id — remove a label. Cascade removes it from all issues
 * (the issues themselves are kept). 204 on success, 404 if not found.
 */
export async function DELETE(_req: Request, ctx: RouteContext) {
  try {
    const db = getDb();
    const { id } = await ctx.params;
    const numericId = Number(id);
    if (!Number.isFinite(numericId)) return notFound("label not found");
    const deleted = deleteLabel(db, numericId);
    if (!deleted) return notFound("label not found");
    return noContent();
  } catch (err) {
    return handleError(err);
  }
}
