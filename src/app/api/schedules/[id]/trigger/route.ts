import { handleError, notFound, ok, parseJson, ValidationError, type RouteContext } from "@/lib/api";
import { getControlPlanePool, getControlPlaneRepository } from "@/lib/control-plane";
import { parseId } from "@/lib/control-plane/validate";
import { triggerScheduleManually } from "@/lib/postgres/scheduling";

/** Demo trigger: the supplied key makes retries resolve to the same cron_tick. */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const scheduleId = parseId(id, "schedule id");
    if (!(await getControlPlaneRepository().getSchedule(scheduleId))) return notFound("schedule not found");
    const body = await parseJson<Record<string, unknown>>(request);
    if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") {
      throw new ValidationError("idempotencyKey must be a non-blank string", "invalid_idempotency_key");
    }
    return ok(await triggerScheduleManually(getControlPlanePool(), scheduleId, body.idempotencyKey));
  } catch (error) {
    return handleError(error);
  }
}
