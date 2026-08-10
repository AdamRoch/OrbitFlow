import { handleError, noContent, notFound, ok, parseJson, type RouteContext } from "@/lib/api";
import { getControlPlaneRepository } from "@/lib/control-plane";
import { resultResponse } from "@/lib/control-plane/http";
import { parseId, parseUpdateSkill } from "@/lib/control-plane/validate";

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const skill = await getControlPlaneRepository().getSkill(parseId(id));
    return skill ? ok(skill) : notFound("skill not found");
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await parseJson<Record<string, unknown>>(request);
    return resultResponse(await getControlPlaneRepository().updateSkill(parseId(id), parseUpdateSkill(body)));
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    return (await getControlPlaneRepository().deleteSkill(parseId(id))) ? noContent() : notFound("skill not found");
  } catch (error) {
    return handleError(error);
  }
}
