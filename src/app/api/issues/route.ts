import { getDb } from "@/lib/db";
import { listIssues, createIssue } from "@/lib/domain";
import {
  handleError,
  ok,
  parseJson,
  requireProject,
} from "@/lib/api";
import {
  parseLabelNames,
  parseOptionalPriority,
  parseOptionalStatus,
  parsePriority,
  parseStatus,
  requireTitle,
  optionalDescription,
} from "@/lib/validate";
import type { CreateIssueInput } from "@/lib/types";
import { publishLocalStateEvent } from "@/lib/state-events";

/**
 * GET /api/issues?status=todo&priority=2&label=ready-for-agent
 * Returns all tickets matching the optional filters.
 */
export async function GET(req: Request) {
  try {
    const db = getDb();
    const url = new URL(req.url);
    const project = requireProject(db);

    const status = url.searchParams.get("status") ?? undefined;
    const priorityParam = url.searchParams.get("priority");
    const label = url.searchParams.get("label") ?? undefined;

    let priority: ReturnType<typeof parsePriority> | undefined;
    // Validate priority from the query string; reject bad values loudly.
    if (priorityParam !== null) priority = parsePriority(priorityParam);

    const filters: Parameters<typeof listIssues>[2] = {};
    if (status) filters.status = parseStatus(status);
    if (priority !== undefined) filters.priority = priority;
    if (label) filters.label = label;

    const issues = listIssues(db, project, filters);
    return ok(issues);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * POST /api/issues
 *   { title, description?, status?, priority?, labelNames?[] }
 *
 * Creates a ticket with the next stable `FACT-N` identifier.
 */
export async function POST(req: Request) {
  try {
    const db = getDb();
    const project = requireProject(db);
    const body = await parseJson<CreateIssueInput>(req);

    const title = requireTitle(body.title);
    const description = optionalDescription(body.description);
    const status = parseOptionalStatus(body.status);
    const priority = parseOptionalPriority(body.priority);
    const labelNames = parseLabelNames(body.labelNames);

    const issue = createIssue(db, project, {
      title,
      description,
      status,
      priority,
      labelNames,
    });
    publishLocalStateEvent({ type: "ticket.created", ticketId: issue.id, runId: null, agentId: null });
    return ok(issue, 201);
  } catch (err) {
    return handleError(err);
  }
}
