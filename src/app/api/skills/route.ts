import { handleError, ok, parseJson } from "@/lib/api";
import { getControlPlaneRepository } from "@/lib/control-plane";
import { parseCreateSkill } from "@/lib/control-plane/validate";

export async function GET() {
  try {
    return ok(await getControlPlaneRepository().listSkills());
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJson<Record<string, unknown>>(request);
    return ok(await getControlPlaneRepository().createSkill(parseCreateSkill(body)), 201);
  } catch (error) {
    return handleError(error);
  }
}
