import { handleError, ok, parseJson } from "@/lib/api";
import { getControlPlaneRepository } from "@/lib/control-plane";
import { parseCreateAgent } from "@/lib/control-plane/validate";

/** GET /api/agents — PostgreSQL-backed agents, including attached skills. */
export async function GET() {
  try {
    return ok(await getControlPlaneRepository().listAgents());
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/agents — all persisted agent fields are explicit. */
export async function POST(request: Request) {
  try {
    const body = await parseJson<Record<string, unknown>>(request);
    return ok(await getControlPlaneRepository().createAgent(parseCreateAgent(body)), 201);
  } catch (error) {
    return handleError(error);
  }
}
