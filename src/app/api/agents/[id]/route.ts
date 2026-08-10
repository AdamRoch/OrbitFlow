import { handleError, noContent, notFound, ok, parseJson, type RouteContext } from "@/lib/api";
import { getControlPlaneRepository } from "@/lib/control-plane";
import { resultResponse } from "@/lib/control-plane/http";
import { parseId, parseUpdateAgent } from "@/lib/control-plane/validate";

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const agent = await getControlPlaneRepository().getAgent(parseId(id));
    return agent ? ok(agent) : notFound("agent not found");
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await parseJson<Record<string, unknown>>(request);
    return resultResponse(await getControlPlaneRepository().updateAgent(parseId(id), parseUpdateAgent(body)));
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    return (await getControlPlaneRepository().deleteAgent(parseId(id))) ? noContent() : notFound("agent not found");
  } catch (error) {
    return handleError(error);
  }
}
