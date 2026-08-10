import { getDb } from "@/lib/db";
import { getFrontier } from "@/lib/domain";
import { handleError, ok, requireProject } from "@/lib/api";

/**
 * GET /api/issues/frontier
 *   Returns `todo` issues whose every blocker is `done`, ordered priority desc
 *   then created asc.
 */
export async function GET() {
  try {
    const db = getDb();
    const project = requireProject(db);
    return ok(getFrontier(db, project));
  } catch (err) {
    return handleError(err);
  }
}
