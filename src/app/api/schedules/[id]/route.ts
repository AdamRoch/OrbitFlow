import { handleError, noContent, notFound, parseJson, resultResponse, type RouteContext } from "@/lib/api";
import { getControlPlaneRepository } from "@/lib/control-plane";
import { parseId, parseUpdateSchedule } from "@/lib/control-plane/validate";

/** FACT-19 can manage agent schedules only; workflow schedules stay out of scope. */

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    return resultResponse(await getControlPlaneRepository().updateAgentSchedule(
      parseId(id),
      parseUpdateSchedule(await parseJson<Record<string, unknown>>(request)),
    ));
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    return (await getControlPlaneRepository().deleteAgentSchedule(parseId(id))) ? noContent() : notFound("schedule not found");
  } catch (error) {
    return handleError(error);
  }
}
