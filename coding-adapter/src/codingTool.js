import {
  createOpenCodeAdapter,
  OPEN_CODE_DEFAULT_MODEL,
} from "./openCodeAdapter.js";
import { CliFailureError, InvalidRequestError } from "./errors.js";

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
  if (
    !costEventStore ||
    typeof costEventStore.verifyAttribution !== "function" ||
    typeof costEventStore.recordDelegation !== "function"
  ) {
    throw new InvalidRequestError("cost event store is required");
  }
  const model = adapterOptions.model ?? OPEN_CODE_DEFAULT_MODEL;
  const workspaceAuthority = workspaceService.authorityForRun(runId);
  if (typeof workspaceAuthority.withDelegation !== "function") {
    throw new InvalidRequestError("workspace service must coordinate delegation lifecycle");
  }
  const adapter = adapterFactory({
    ...adapterOptions,
    model,
    workspaceAuthority,
  });

  async function delegate_coding_task(task, workspace, { signal: callerSignal } = {}) {
    if (typeof task !== "string" || task.trim() === "") {
      throw new InvalidRequestError("task must be a non-empty string");
    }
    if (typeof workspace !== "string" || workspace.trim() === "") {
      throw new InvalidRequestError("workspace must be a non-empty string");
    }

    return workspaceAuthority.withDelegation(async ({ signal: workspaceSignal }) => {
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, workspaceSignal])
        : workspaceSignal;
      throwIfAborted(signal);
      await costEventStore.verifyAttribution({ runId, agentId });
      const result = await adapter.delegate_coding_task(task, workspace, { signal });
      throwIfAborted(signal);
      await costEventStore.recordDelegation({
        runId,
        agentId,
        model,
        usage: result.usage,
      });
      return result;
    });
  }

  return { delegate_coding_task };
}

function throwIfAborted(signal) {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new CliFailureError("coding delegation was cancelled");
}
