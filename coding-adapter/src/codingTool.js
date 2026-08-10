import {
  createOpenCodeAdapter,
  OPEN_CODE_DEFAULT_MODEL,
} from "./openCodeAdapter.js";
import { InvalidRequestError } from "./errors.js";

export function createCodingTool({
  runId,
  agentId,
  workspaceService,
  costEventStore,
  adapterFactory = createOpenCodeAdapter,
  adapterOptions = {},
} = {}) {
  if (!workspaceService || typeof workspaceService.authorityForRun !== "function") {
    throw new InvalidRequestError("workspace service is required");
  }
  if (!costEventStore || typeof costEventStore.recordDelegation !== "function") {
    throw new InvalidRequestError("cost event store is required");
  }
  const model = adapterOptions.model ?? OPEN_CODE_DEFAULT_MODEL;
  const adapter = adapterFactory({
    ...adapterOptions,
    model,
    workspaceAuthority: workspaceService.authorityForRun(runId),
  });

  async function delegate_coding_task(task, workspace) {
    if (typeof task !== "string" || task.trim() === "") {
      throw new InvalidRequestError("task must be a non-empty string");
    }
    if (typeof workspace !== "string" || workspace.trim() === "") {
      throw new InvalidRequestError("workspace must be a non-empty string");
    }

    const result = await adapter.delegate_coding_task(task, workspace);
    await costEventStore.recordDelegation({
      runId,
      agentId,
      model,
      usage: result.usage,
    });
    return result;
  }

  return { delegate_coding_task };
}
