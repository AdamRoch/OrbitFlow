import { handleError, noContent, notFound, ok, parseJson, type RouteContext } from "@/lib/api";
import { getControlPlaneRepository } from "@/lib/control-plane";
import { resultResponse } from "@/lib/control-plane/http";
import { parseId, parseUpdateWorkflow } from "@/lib/control-plane/validate";

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const workflow = await getControlPlaneRepository().getWorkflow(parseId(id));
    return workflow ? ok(workflow) : notFound("workflow not found");
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await parseJson<Record<string, unknown>>(request);
    return resultResponse(await getControlPlaneRepository().updateWorkflow(parseId(id), parseUpdateWorkflow(body)));
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    return (await getControlPlaneRepository().deleteWorkflow(parseId(id))) ? noContent() : notFound("workflow not found");
  } catch (error) {
    return handleError(error);
  }
}
