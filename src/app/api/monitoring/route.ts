import { handleError, ok, ValidationError } from "@/lib/api";
import { getControlPlaneRepository } from "@/lib/control-plane";
import type { MonitoringFilters } from "@/lib/control-plane/types";
import { parseId } from "@/lib/control-plane/validate";
import { MESSAGE_TYPES } from "@/lib/message-types";

/**
 * GET /api/monitoring?runId=&agentId=&messageType=
 *
 * The response is an authoritative, deliberately bounded PostgreSQL snapshot.
 * SSE never carries display data or grants a client permission to write.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const optionalId = (field: "runId" | "agentId") => {
      const value = url.searchParams.get(field);
      return value === null || value === "" ? null : parseId(value, field);
    };
    const messageType = url.searchParams.get("messageType");
    if (messageType !== null && messageType !== "" && !MESSAGE_TYPES.includes(messageType as typeof MESSAGE_TYPES[number])) {
      throw new ValidationError("messageType must be a known message type", "invalid_message_type");
    }
    const filters: MonitoringFilters = {
      runId: optionalId("runId"),
      agentId: optionalId("agentId"),
      messageType: messageType || null,
    };
    return ok(await getControlPlaneRepository().getMonitoringSnapshot(filters));
  } catch (error) {
    return handleError(error);
  }
}
