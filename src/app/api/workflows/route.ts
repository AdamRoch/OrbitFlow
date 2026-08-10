import { handleError, ok, parseJson } from "@/lib/api";
import { getControlPlaneRepository } from "@/lib/control-plane";
import { parseCreateWorkflow } from "@/lib/control-plane/validate";

export async function GET() {
  try {
    return ok(await getControlPlaneRepository().listWorkflows());
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJson<Record<string, unknown>>(request);
    return ok(await getControlPlaneRepository().createWorkflow(parseCreateWorkflow(body)), 201);
  } catch (error) {
    return handleError(error);
  }
}
