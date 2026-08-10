import { getDb } from "@/lib/db";
import { deleteIssue, getIssue, updateIssue } from "@/lib/domain";
import {
  handleError,
  noContent,
  notFound,
  ok,
  parseJson,
  requireProject,
  RouteContext,
} from "@/lib/api";
import {
  optionalDescription,
  parseOptionalPriority,
  parseOptionalStatus,
  requireTitle,
} from "@/lib/validate";
import type { UpdateIssueInput } from "@/lib/types";
import { publishLocalStateEvent } from "@/lib/state-events";

/**
 * GET /api/issues/:id — `:id` may be the numeric id or an identifier such as
 * `FACT-42`.
 */
export async function GET(_req: Request, ctx: RouteContext) {
  try {
    const db = getDb();
    const project = requireProject(db);
    const { id } = await ctx.params;
    const issue = getIssue(db, project, id);
    if (!issue) return notFound("issue not found");
    return ok(issue);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * PATCH /api/issues/:id — partial update of title, description, status, and
 * priority.
 */
export async function PATCH(req: Request, ctx: RouteContext) {
  try {
    const db = getDb();
    const project = requireProject(db);
    const { id } = await ctx.params;
    const body = await parseJson<UpdateIssueInput>(req);

    const args: Parameters<typeof updateIssue>[3] = {};
    if (body.title !== undefined) args.title = requireTitle(body.title);
    if (body.description !== undefined) {
      args.description = optionalDescription(body.description);
    }
    if (body.status !== undefined) {
      args.status = parseOptionalStatus(body.status);
    }
    if (body.priority !== undefined) {
      args.priority = parseOptionalPriority(body.priority);
    }

    const updated = updateIssue(db, project, id, args);
    if (!updated) return notFound("issue not found");
    publishLocalStateEvent({ type: "ticket.updated", ticketId: updated.id, runId: null, agentId: null });
    return ok(updated);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * DELETE /api/issues/:id — removes the issue and, via cascade, its label and
 * dependency rows. Returns 204, or 404 if it never existed.
 */
export async function DELETE(_req: Request, ctx: RouteContext) {
  try {
    const db = getDb();
    const project = requireProject(db);
    const { id } = await ctx.params;
    const existing = getIssue(db, project, id);
    if (!existing) return notFound("issue not found");
    const deleted = deleteIssue(db, project, id);
    if (!deleted) return notFound("issue not found");
    publishLocalStateEvent({ type: "ticket.deleted", ticketId: existing.id, runId: null, agentId: null });
    return noContent();
  } catch (err) {
    return handleError(err);
  }
}
