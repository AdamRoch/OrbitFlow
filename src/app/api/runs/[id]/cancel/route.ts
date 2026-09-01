import { conflict, handleError, ok, type RouteContext } from "@/lib/api";
import { getControlPlanePool } from "@/lib/control-plane";
import {
  cancelWorkflowRun,
  WorkflowStateError,
} from "@/lib/postgres/workflow-engine";

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    return ok(await cancelWorkflowRun(getControlPlanePool(), id));
  } catch (error) {
    if (error instanceof WorkflowStateError) {
      return conflict(error.message, "invalid_run_transition");
    }
    return handleError(error);
  }
}
