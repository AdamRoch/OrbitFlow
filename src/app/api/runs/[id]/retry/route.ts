import { badRequest, conflict, handleError, ok, parseJson, type RouteContext } from "@/lib/api";
import { getControlPlanePool } from "@/lib/control-plane";
import {
  retryWorkflowRun,
  WorkflowStateError,
} from "@/lib/postgres/workflow-engine";

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await parseJson<{ idempotencyKey?: unknown }>(request);
    if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") {
      return badRequest("idempotencyKey must be a non-blank string", "invalid_idempotency_key");
    }
    return ok(
      await retryWorkflowRun(getControlPlanePool(), id, body.idempotencyKey),
      201,
    );
  } catch (error) {
    if (error instanceof WorkflowStateError) {
      return conflict(error.message, "run_retry_blocked");
    }
    return handleError(error);
  }
}
