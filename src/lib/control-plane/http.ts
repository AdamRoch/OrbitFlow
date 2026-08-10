import { conflict, notFound, noContent, ok } from "../api";
import type { UpdateResult } from "./types";

export function resultResponse<T>(result: UpdateResult<T>) {
  if (result.kind === "updated") return ok(result.value);
  if (result.kind === "not_found") return notFound();
  return conflict("resource has changed since expectedUpdatedAt", "stale_update");
}

export function resourceResponse(result: "attached" | "detached" | "agent_not_found" | "skill_not_found", status = 200) {
  if (result === "agent_not_found") return notFound("agent not found");
  if (result === "skill_not_found") return notFound("skill not found");
  if (result === "attached") return ok({ attached: true }, status as 200 | 201);
  return noContent();
}
