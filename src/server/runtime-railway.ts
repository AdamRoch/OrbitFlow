import {
  Sandbox,
  SandboxFailedError,
  SandboxTimeoutError,
  type CreateOptions,
  type ExecHandle,
} from "railway";
import type {
  ExecuteTurnInput,
  RuntimeEvent,
  RuntimeResult,
  RuntimeStatus,
  RuntimeUsage,
} from "./runtime.js";
import {
  parseModel,
  providerKeyName,
  RuntimeFailure,
  runtimeVersion,
} from "./runtime.js";

type RunnerFrame =
  | { type: "event"; event: RuntimeEvent }
  | { type: "result"; result: RuntimeResult }
  | { type: "failure"; message: string; usage: RuntimeUsage };

const unknownUsage = (): RuntimeUsage => ({
  costUsd: null,
  inputTokens: 0,
  outputTokens: 0,
});

function settings(model?: string) {
  const checkpoint = process.env.ORBITFLOW_SANDBOX_CHECKPOINT;
  const token = process.env.RAILWAY_TOKEN;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  const provider = model ? parseModel(model).provider : null;
  const keyName = provider ? providerKeyName(provider) : null;
  const credential = keyName ? process.env[keyName] : null;
  return { checkpoint, token, environmentId, keyName, credential };
}

export async function railwayRuntimeStatus(model?: string): Promise<RuntimeStatus> {
  try {
    const configured = settings(model);
    const missing = !configured.checkpoint
      ? "Missing ORBITFLOW_SANDBOX_CHECKPOINT"
      : !configured.token
        ? "Missing RAILWAY_TOKEN"
        : !configured.environmentId
          ? "Missing RAILWAY_ENVIRONMENT_ID"
          : model && !configured.credential
            ? `Missing ${configured.keyName}`
            : null;
    return {
      available: missing === null,
      image: `orbitflow-runtime:${runtimeVersion}`,
      version: runtimeVersion,
      providerConfigured: Boolean(configured.credential),
      reason: missing,
    };
  } catch (error) {
    return {
      available: false,
      image: `orbitflow-runtime:${runtimeVersion}`,
      version: runtimeVersion,
      providerConfigured: false,
      reason: error instanceof Error ? error.message : "Invalid Railway runtime configuration",
    };
  }
}

export function createRunnerFrameParser(
  onFrame: (frame: RunnerFrame) => void,
) {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      if (buffer.length > 12 * 1024 * 1024)
        throw new Error("Railway runtime frame exceeds 12 MiB");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) {
          const frame = JSON.parse(line) as RunnerFrame;
          if (
            !frame ||
            !["event", "result", "failure"].includes(frame.type)
          )
            throw new Error("Railway runtime emitted an invalid frame");
          if (
            (frame.type === "event" &&
              (!frame.event || typeof frame.event.content !== "string")) ||
            (frame.type === "result" &&
              (!frame.result ||
                typeof frame.result.outcome !== "string" ||
                typeof frame.result.summary !== "string" ||
                !frame.result.files ||
                typeof frame.result.files !== "object" ||
                typeof frame.result.inputTokens !== "number" ||
                typeof frame.result.outputTokens !== "number" ||
                (frame.result.costUsd !== null && typeof frame.result.costUsd !== "number"))) ||
            (frame.type === "failure" &&
              (!frame.usage ||
                typeof frame.message !== "string" ||
                typeof frame.usage.inputTokens !== "number" ||
                typeof frame.usage.outputTokens !== "number" ||
                (frame.usage.costUsd !== null && typeof frame.usage.costUsd !== "number")))
          )
            throw new Error("Railway runtime emitted an incomplete frame");
          onFrame(frame);
        }
        newline = buffer.indexOf("\n");
      }
    },
    finish() {
      if (buffer)
        throw new Error("Railway runtime ended with an incomplete frame");
    },
  };
}

export async function executeRailwayTurn(
  input: ExecuteTurnInput,
  transportStub?: {
    createSandbox: (checkpoint: string, options: CreateOptions) => Promise<Sandbox>;
  },
): Promise<RuntimeResult> {
  if (input.signal?.aborted)
    throw new RuntimeFailure("Runtime turn aborted", {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  if (!(input.maxCostUsd > 0) || !Number.isFinite(input.maxCostUsd))
    throw new Error("Runtime cost limit must be a positive finite amount");
  const configured = settings(input.agent.model);
  if (!configured.checkpoint || !configured.token || !configured.environmentId)
    throw new Error("Railway runtime requires a project token, environment, and checkpoint");
  if (!configured.keyName || !configured.credential)
    throw new Error(`Missing ${configured.keyName ?? "provider credential"}`);

  let sandbox: Sandbox | null = null;
  let handle: ExecHandle | null = null;
  let runnerStarted = false;
  const terminal: { frame: Extract<RunnerFrame, { type: "result" | "failure" }> | null } = { frame: null };
  let destroyPromise: Promise<void> | null = null;
  const destroyExactSandbox = () => {
    if (!sandbox) return Promise.resolve();
    destroyPromise ??= sandbox.destroy();
    return destroyPromise;
  };
  const onAbort = () => {
    if (handle) void handle.kill("KILL").catch(() => undefined);
    if (sandbox) void destroyExactSandbox().catch(() => undefined);
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // No application or database credential enters this VM. The chosen provider
    // key is available only to the trusted runner and its inner OpenCode container.
    const creationOptions: CreateOptions = {
      token: configured.token,
      authType: "project-token",
      environmentId: configured.environmentId,
      idleTimeoutMinutes: 10,
      networkIsolation: "ISOLATED",
      env: { [configured.keyName]: configured.credential },
    };
    sandbox = transportStub
      ? await transportStub.createSandbox(configured.checkpoint, creationOptions)
      : await Sandbox.create(configured.checkpoint, creationOptions);
    void Promise.resolve(input.onEvent?.({
      kind: "status",
      content: `Railway sandbox ready: ${sandbox.id}`,
    })).catch(() => undefined);
    if (input.signal?.aborted)
      throw new RuntimeFailure("Runtime turn aborted", {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      });

    await sandbox.files.write(
      "/runtime/input.json",
      JSON.stringify({
        id: input.id,
        agent: input.agent,
        prompt: input.prompt,
        files: input.files,
        maxCostUsd: input.maxCostUsd,
        allowedOutcomes: input.allowedOutcomes,
      }),
      { mode: 0o600 },
    );
    if (input.signal?.aborted)
      throw new RuntimeFailure("Runtime turn aborted", {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      });

    const parser = createRunnerFrameParser((frame) => {
      if (frame.type === "event") {
        void Promise.resolve(input.onEvent?.(frame.event)).catch(() => undefined);
      } else {
        if (terminal.frame)
          throw new Error("Railway runtime emitted more than one terminal frame");
        terminal.frame = frame;
      }
    });
    runnerStarted = true;
    handle = sandbox.exec("node /opt/orbitflow/runtime-runner.mjs /runtime/input.json", {
      timeoutSec: 12 * 60,
      onStdout: (chunk) => parser.push(chunk),
      onStderr: () => {
        // Runtime diagnostics are not copied to application logs. They may
        // contain provider or generated-code details.
      },
    });
    const execution = await handle;
    parser.finish();
    if (input.signal?.aborted)
      throw new RuntimeFailure("Runtime turn aborted", unknownUsage());
    if (execution.timedOut)
      throw new RuntimeFailure("Railway runtime runner exceeded 12 minutes", unknownUsage());
    if (!terminal.frame)
      throw new RuntimeFailure("Railway runtime ended without a result", unknownUsage());
    if (terminal.frame.type === "failure")
      throw new RuntimeFailure(terminal.frame.message, terminal.frame.usage);
    if (execution.exitCode !== 0)
      throw new RuntimeFailure("Railway runtime exited after a result with nonzero status", unknownUsage());
    return terminal.frame.result;
  } catch (error) {
    if (
      !sandbox &&
      (error instanceof SandboxTimeoutError || error instanceof SandboxFailedError)
    ) {
      // Create can fail after Railway assigned an ID. Reattach and destroy that
      // exact VM; if it has already disappeared, its idle policy still bounds it.
      await Sandbox.connect(error.id, {
        token: configured.token,
        authType: "project-token",
        environmentId: configured.environmentId,
      })
        .then(async (created) => {
          sandbox = created;
          await destroyExactSandbox();
        })
        .catch(() => undefined);
    }
    if (error instanceof RuntimeFailure) throw error;
    const message = input.signal?.aborted
      ? "Runtime turn aborted"
      : error instanceof Error
        ? error.message
        : "Railway runtime failed";
    throw new RuntimeFailure(
      message.replaceAll(configured.credential, "[redacted]").slice(0, 500),
      runnerStarted ? unknownUsage() : { costUsd: 0, inputTokens: 0, outputTokens: 0 },
      error,
    );
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    if (handle && input.signal?.aborted)
      await handle.kill("KILL").catch(() => undefined);
    if (sandbox) {
      let teardownTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          destroyExactSandbox(),
          new Promise<never>((_, reject) => {
            teardownTimer = setTimeout(
              () => reject(new Error(`Railway sandbox teardown unconfirmed: ${sandbox!.id}`)),
              30_000,
            );
          }),
        ]);
      } finally {
        if (teardownTimer) clearTimeout(teardownTimer);
      }
    }
  }
}
