import { getDb } from "@/lib/db";
import { addBlocker, getBlockers } from "@/lib/domain";
import {
  badRequest,
  handleError,
  notFound,
  ok,
  parseJson,
  requireProject,
  RouteContext,
} from "@/lib/api";

interface AddBlockerBody {
  blockerId?: unknown;
}

/**
 * GET /api/issues/:id/blockers — the issues that block this one.
 */
export async function GET(_req: Request, ctx: RouteContext) {
  try {
    const db = getDb();
    const project = requireProject(db);
    const { id } = await ctx.params;
    const blockers = getBlockers(db, project, id);
    if (blockers === null) return notFound("issue not found");
    return ok(blockers);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * POST /api/issues/:id/blockers  { blockerId: number|string }
 *   Add an edge: `blockerId` blocks `:id`. Rejects self-edges and cycles
 *   (400), or if either issue is missing (404).
 */
export async function POST(req: Request, ctx: RouteContext) {
  try {
    const db = getDb();
    const project = requireProject(db);
    const { id } = await ctx.params;
    const body = await parseJson<AddBlockerBody>(req);

    if (body.blockerId === undefined || body.blockerId === null) {
      return badRequest("blockerId is required", "missing");
    }
    const blockerId = body.blockerId;

    const result = addBlocker(db, project, id, blockerId as string | number);
    if (result === null) return notFound("issue not found");

    // The contract says 201 on creation; we return the edge object either way
    // but use 201 to signal "the relationship now exists."
    return ok(result, 201);
  } catch (err) {
    return handleError(err);
  }
}
