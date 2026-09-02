import { handleError, ok, parseJson, ValidationError, type RouteContext } from "@/lib/api";
import { getControlPlanePool } from "@/lib/control-plane";
import { parseId } from "@/lib/control-plane/validate";
import { answerWorkflowQuestionFromUi } from "@/lib/postgres/workflow-questions";

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const questionId = parseId(id, "question id");
    const body = await parseJson<Record<string, unknown>>(request);
    for (const field of Object.keys(body)) {
      if (!["answer", "approved"].includes(field)) throw new ValidationError(`unknown field: ${field}`, "unknown_field");
    }
    if (typeof body.answer !== "string" || body.answer.trim() === "") {
      throw new ValidationError("answer must be a non-blank string", "invalid_answer");
    }
    if (body.approved !== undefined && typeof body.approved !== "boolean") {
      throw new ValidationError("approved must be a boolean", "invalid_approved");
    }
    const result = await answerWorkflowQuestionFromUi(getControlPlanePool(), questionId, {
      answer: body.answer,
      ...(body.approved === undefined ? {} : { approved: body.approved }),
    });
    return ok(result);
  } catch (error) {
    return handleError(error);
  }
}
