import { handleError, type RouteContext } from "@/lib/api";
import { getControlPlaneRepository } from "@/lib/control-plane";
import { resourceResponse } from "@/lib/control-plane/http";
import { parseId } from "@/lib/control-plane/validate";

type SkillContext = RouteContext<{ id: string; skillId: string }>;

/** PUT is deliberately idempotent: a duplicate attachment still returns 200. */
export async function PUT(_request: Request, context: SkillContext) {
  try {
    const { id, skillId } = await context.params;
    return resourceResponse(await getControlPlaneRepository().attachSkill(parseId(id, "agent id"), parseId(skillId, "skill id")));
  } catch (error) {
    return handleError(error);
  }
}

/** DELETE is deliberately idempotent: an already-detached pair returns 204. */
export async function DELETE(_request: Request, context: SkillContext) {
  try {
    const { id, skillId } = await context.params;
    return resourceResponse(await getControlPlaneRepository().detachSkill(parseId(id, "agent id"), parseId(skillId, "skill id")));
  } catch (error) {
    return handleError(error);
  }
}
