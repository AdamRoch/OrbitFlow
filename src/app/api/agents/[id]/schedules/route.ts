import { handleError, notFound, ok, parseJson, type RouteContext } from "@/lib/api";
import { getControlPlaneRepository } from "@/lib/control-plane";
import { parseCreateAgentSchedule, parseId } from "@/lib/control-plane/validate";

/** Schedules are persisted control-plane associations; execution belongs to FACT-25. */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const agentId = parseId(id, "agent id");
    const repository = getControlPlaneRepository();
    if (!(await repository.getAgent(agentId))) return notFound("agent not found");
    return ok(await repository.listSchedulesForAgent(agentId));
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const schedule = await getControlPlaneRepository().createAgentSchedule(
      parseId(id, "agent id"),
      parseCreateAgentSchedule(await parseJson<Record<string, unknown>>(request)),
    );
    return schedule ? ok(schedule, 201) : notFound("agent not found");
  } catch (error) {
    return handleError(error);
  }
}
