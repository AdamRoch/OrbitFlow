import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Agent } from "../shared/types.js";

export const runtimeVersion = "1.18.29";

const image =
  process.env.ORBITFLOW_RUNTIME_IMAGE ?? `orbitflow-runtime:${runtimeVersion}`;
const maximumArtifactBytes = 8 * 1024 * 1024;
const turnTimeoutMs = Number(
  process.env.ORBITFLOW_RUNTIME_TIMEOUT_MS ?? 10 * 60_000,
);
const artifactExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
]);
const runtimeInstructionNames = new Set([
  "agents.md",
  "claude.md",
  "opencode.json",
  "opencode.jsonc",
]);

const providerEnvironment: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export type RuntimeEvent = {
  kind: "status" | "runtime";
  content: string;
  detail?: unknown;
};

export type ExecuteTurnInput = {
  id: string;
  agent: Agent;
  prompt: string;
  files: Record<string, string>;
  maxCostUsd: number;
  allowedOutcomes?: string[];
  signal?: AbortSignal;
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
};

export type RuntimeResult = {
  summary: string;
  outcome: string;
  files: Record<string, string>;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
};

export type RuntimeUsage = Pick<
  RuntimeResult,
  "costUsd" | "inputTokens" | "outputTokens"
>;

export class RuntimeFailure extends Error {
  readonly usage: RuntimeUsage;

  constructor(message: string, usage: RuntimeUsage, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RuntimeFailure";
    this.usage = usage;
  }
}

export type RuntimeStatus = {
  available: boolean;
  image: string;
  version: string;
  providerConfigured: boolean;
  reason: string | null;
};

type AssistantResponse = {
  info?: {
    id?: string;
    error?: { name?: string; message?: string };
    cost?: number;
    tokens?: { input?: number; output?: number };
    structured?: unknown;
  };
};

type SessionMessage = {
  info?: {
    role?: string;
    cost?: number;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
    time?: { completed?: number };
  };
};

const unknownUsage = (): RuntimeUsage => ({
  costUsd: null,
  inputTokens: 0,
  outputTokens: 0,
});

export function aggregateRuntimeUsage(
  messages: SessionMessage[],
): RuntimeUsage {
  let cost = 0;
  let costKnown = true;
  let assistants = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const message of messages) {
    if (message.info?.role !== "assistant") continue;
    assistants++;
    if (
      typeof message.info.cost === "number" &&
      Number.isFinite(message.info.cost)
    )
      cost += message.info.cost;
    else costKnown = false;
    // OpenCode 1.18.29 stores mutually exclusive categories: input excludes
    // cache reads/writes and output excludes reasoning. OrbitFlow's two public
    // counters are inclusive, so each category is added exactly once.
    inputTokens +=
      (message.info.tokens?.input ?? 0) +
      (message.info.tokens?.cache?.read ?? 0) +
      (message.info.tokens?.cache?.write ?? 0);
    outputTokens +=
      (message.info.tokens?.output ?? 0) +
      (message.info.tokens?.reasoning ?? 0);
  }
  return {
    costUsd: assistants > 0 && costKnown ? cost : null,
    inputTokens,
    outputTokens,
  };
}

export function observeAssistantCost(
  costs: Map<string, number>,
  event: unknown,
  sessionID: string,
): number | null {
  if (!event || typeof event !== "object") return null;
  if (Reflect.get(event, "type") !== "message.updated") return null;
  const properties = Reflect.get(event, "properties");
  if (!properties || typeof properties !== "object") return null;
  const info = Reflect.get(properties, "info");
  if (!info || typeof info !== "object") return null;
  if (
    Reflect.get(info, "role") !== "assistant" ||
    Reflect.get(info, "sessionID") !== sessionID
  )
    return null;
  const id = Reflect.get(info, "id");
  const cost = Reflect.get(info, "cost");
  if (
    typeof id !== "string" ||
    typeof cost !== "number" ||
    !Number.isFinite(cost) ||
    cost < 0
  )
    return null;
  costs.set(id, cost);
  return [...costs.values()].reduce((total, value) => total + value, 0);
}

export async function runtimeStatus(model?: string): Promise<RuntimeStatus> {
  if (process.env.ORBITFLOW_RUNTIME_TRANSPORT === "railway") {
    const { railwayRuntimeStatus } = await import("./runtime-railway.js");
    return railwayRuntimeStatus(model);
  }
  const provider = model ? parseModel(model).provider : null;
  const providerConfigured = provider ? Boolean(providerKey(provider)) : false;
  try {
    await command("docker", ["image", "inspect", image], { timeoutMs: 8_000 });
    return {
      available: model ? providerConfigured : true,
      image,
      version: runtimeVersion,
      providerConfigured,
      reason:
        model && !providerConfigured
          ? `Missing ${providerKeyName(provider!)}`
          : null,
    };
  } catch {
    return {
      available: false,
      image,
      version: runtimeVersion,
      providerConfigured,
      reason: `Runtime image ${image} is not available`,
    };
  }
}

export async function runtimeAvailable(model?: string): Promise<boolean> {
  return (await runtimeStatus(model)).available;
}

export async function executeTurn(
  input: ExecuteTurnInput,
): Promise<RuntimeResult> {
  if (process.env.ORBITFLOW_RUNTIME_TRANSPORT === "railway") {
    const { executeRailwayTurn } = await import("./runtime-railway.js");
    return executeRailwayTurn(input);
  }
  return executeLocalTurn(input);
}

export async function executeLocalTurn(
  input: ExecuteTurnInput,
): Promise<RuntimeResult> {
  if (input.signal?.aborted) throw abortError();
  if (!(input.maxCostUsd > 0) || !Number.isFinite(input.maxCostUsd))
    throw new Error("Runtime cost limit must be a positive finite amount");
  const costController = new AbortController();
  input = {
    ...input,
    signal: AbortSignal.any([
      ...(input.signal ? [input.signal] : []),
      costController.signal,
      AbortSignal.timeout(turnTimeoutMs),
    ]),
  };

  const { provider, modelID } = parseModel(input.agent.model);
  const credential = providerKey(provider);
  if (!credential)
    throw new Error(`Missing ${providerKeyName(provider)} for ${provider}`);

  const safeID =
    input.id.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 36) || "turn";
  const container = `orbitflow-turn-${safeID}-${randomBytes(4).toString("hex")}`;
  const turnRoot = await mkdtemp(join(tmpdir(), "orbitflow-turn-"));
  const workspace = join(turnRoot, "workspace");
  const configPath = join(turnRoot, "opencode.json");
  const password = randomBytes(24).toString("base64url");
  let sessionID: string | null = null;
  let baseUrl: string | null = null;
  let timedOut = false;
  let costLimitReached = false;
  let providerStarted = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let eventStream: ReturnType<typeof streamEvents> | null = null;

  const removeContainer = async () => {
    await command("docker", ["rm", "--force", container], {
      timeoutMs: 15_000,
    }).catch(() => undefined);
  };
  const abortSession = async () => {
    if (baseUrl && sessionID) {
      await api(
        baseUrl,
        password,
        `/session/${encodeURIComponent(sessionID)}/abort`,
        {
          method: "POST",
          signal: AbortSignal.timeout(2_000),
        },
      ).catch(() => undefined);
    }
  };
  const stop = async () => {
    await abortSession();
    await removeContainer();
  };
  const readUsage = async (): Promise<RuntimeUsage> => {
    if (!providerStarted)
      return { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    if (!baseUrl || !sessionID) return unknownUsage();
    try {
      const response = await api<unknown>(
        baseUrl,
        password,
        `/session/${encodeURIComponent(sessionID)}/message`,
        { signal: AbortSignal.timeout(8_000) },
      );
      const messages = Array.isArray(response)
        ? (response as SessionMessage[])
        : null;
      if (!messages) return unknownUsage();
      const assistants = messages.filter(
        (message) => message.info?.role === "assistant",
      );
      if (
        assistants.length &&
        assistants.every(
          (message) =>
            typeof message.info?.cost === "number" &&
            typeof message.info.time?.completed === "number",
        )
      )
        return aggregateRuntimeUsage(messages);
    } catch (error) {
      emit(input, "status", `Best-effort failure usage read: ${sanitizedError(error)}`);
    }
    return unknownUsage();
  };
  const onAbort = () => {
    if (baseUrl && sessionID) void abortSession();
    else void removeContainer();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  timeout = setTimeout(() => {
    timedOut = true;
    onAbort();
  }, turnTimeoutMs);

  try {
    await mkdir(workspace, { recursive: true });
    await command("git", ["init", "--quiet", workspace], { timeoutMs: 8_000 });
    await writeInputFiles(workspace, input.files);
    await writeFile(
      configPath,
      JSON.stringify(runtimeConfig(input.agent), null, 2),
      { mode: 0o600 },
    );
    const innerUid = process.env.ORBITFLOW_INNER_UID;
    if (innerUid) {
      if (innerUid !== "1000" || (typeof process.getuid === "function" && process.getuid() !== 0))
        throw new Error("Railway inner UID requires a trusted root runner and UID 1000");
      await command("chown", ["-R", "1000:1000", workspace, configPath], {
        timeoutMs: 8_000,
      });
    }
    if (input.signal?.aborted) throw abortError();
    emit(input, "status", `Starting OpenCode ${runtimeVersion}`);
    const uid = innerUid ? 1000 : typeof process.getuid === "function" ? process.getuid() : 1000;
    const gid = innerUid ? 1000 : typeof process.getgid === "function" ? process.getgid() : 1000;
    await command(
      "docker",
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        container,
        "--publish",
        "127.0.0.1::4096",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "160",
        "--memory",
        "1g",
        "--cpus",
        "1.5",
        "--user",
        `${uid}:${gid}`,
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=256m,mode=1777",
        "--mount",
        `type=bind,src=${workspace},dst=/workspace`,
        "--mount",
        `type=bind,src=${configPath},dst=/runtime/opencode.json,readonly`,
        "--env",
        "OPENCODE_CONFIG=/runtime/opencode.json",
        "--env",
        `OPENCODE_SERVER_PASSWORD=${password}`,
        "--env",
        providerKeyName(provider),
        image,
      ],
      { timeoutMs: 30_000 },
    );

    const port = await waitForPort(container, input.signal);
    baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, password, input.signal);
    emit(input, "status", "Runtime ready");

    const session = await api<{ id: string }>(baseUrl, password, "/session", {
      method: "POST",
      signal: boundedSignal(input.signal, 15_000),
      body: JSON.stringify({ title: `OrbitFlow ${input.id}` }),
    });
    sessionID = session.id;
    emit(input, "status", "Session ready");
    if (input.signal?.aborted) throw abortError();

    const events = streamEvents(
      baseUrl,
      password,
      input,
      sessionID,
      input.maxCostUsd,
      () => {
        if (costLimitReached) return;
        costLimitReached = true;
        emit(
          input,
          "status",
          `Observed runtime cost reached $${input.maxCostUsd.toFixed(4)}; stopping further work`,
        );
        costController.abort();
      },
      input.signal,
    );
    eventStream = events;
    const eventStreamConnected = await Promise.race([
      events.ready.then(() => true),
      delay(2_000).then(() => false),
    ]);
    if (!eventStreamConnected)
      throw new Error("Runtime event stream did not become ready before prompt");
    providerStarted = true;
    const response = await api<AssistantResponse>(
      baseUrl,
      password,
      `/session/${encodeURIComponent(sessionID)}/message`,
      {
        method: "POST",
        signal: input.signal,
        body: JSON.stringify({
          agent: "orbitflow-agent",
          model: { providerID: provider, modelID },
          tools: nativeTools(input.agent),
          parts: [{ type: "text", text: input.prompt }],
          format: {
            type: "json_schema",
            retryCount: 2,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["summary", "outcome"],
              properties: {
                summary: {
                  type: "string",
                  description:
                    "Concise account of work completed or review feedback.",
                },
                outcome: {
                  type: "string",
                  minLength: 1,
                  ...(input.allowedOutcomes?.length
                    ? { enum: [...new Set(input.allowedOutcomes)] }
                    : {}),
                  description:
                    "Workflow route selected by this agent, such as review, revise, approved, or completed.",
                },
              },
            },
          },
        }),
      },
    );
    if (response.info?.error) {
      throw new Error(
        `OpenCode ${response.info.error.name ?? "error"}: ${response.info.error.message ?? "request failed"}`,
      );
    }
    const structured = parseStructured(response.info?.structured);
    await Promise.race([events.idle, delay(8_000)]);
    const usage = events.completeUsage(response.info?.id) ?? unknownUsage();
    emit(
      input,
      "status",
      usage.costUsd === null
        ? "Complete session usage was unavailable"
        : "Usage retained from complete session event snapshots after session.idle",
    );
    events.abort();
    emit(input, "status", `Runtime finished: ${structured.outcome}`);
    return {
      ...structured,
      files: await readOutputFiles(workspace),
      ...usage,
    };
  } catch (error) {
    const usage = eventStream?.completeUsage() ?? (await readUsage());
    const message = costLimitReached
      ? `Runtime turn reached its $${input.maxCostUsd.toFixed(4)} observed cost limit`
      : input.signal?.aborted
        ? "Runtime turn aborted"
      : timedOut
        ? `Runtime turn exceeded ${turnTimeoutMs}ms`
        : error instanceof Error
          ? error.message
          : "Runtime turn failed";
    throw new RuntimeFailure(message, usage, error);
  } finally {
    if (timeout) clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
    await stop();
    await rm(turnRoot, { recursive: true, force: true });
  }
}

export function runtimeConfig(agent: Agent) {
  const tools = new Set(agent.tools.map((tool) => tool.toLowerCase()));
  const canEdit = tools.has("edit") || tools.has("write");
  const procedures = agent.skills
    .map(
      (skill) =>
        `${skill.name}:\n${skill.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`,
    )
    .join("\n\n");
  const system = [
    agent.systemPrompt,
    `Role: ${agent.role}`,
    agent.memory.length
      ? `Persistent memory:\n${agent.memory.map((fact) => `- ${fact}`).join("\n")}`
      : "",
    procedures ? `Available procedures:\n${procedures}` : "",
    `Approval policy: ${agent.approval}.`,
    `Blocked actions: ${agent.guardrails.blockedActions.join(", ") || "none configured"}.`,
    "Work only in /workspace. Do not attempt to run the generated application. Finish with the requested structured result.",
    "Use file tools efficiently: read small files whole; inspect large files in broad 300–500-line ranges with targeted grep. Plan a bounded inspection, normally no more than 6 read or search calls before producing a decision. Do not exhaustively search speculative patterns. When reviewing feedback, inspect the affected code and decisive checks, avoid reauditing the full application, and conclude once the evidence supports a result.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    agent: {
      "orbitflow-agent": {
        description: agent.role,
        mode: "primary",
        model: agent.model,
        prompt: system,
        permission: {
          "*": "deny",
          read: tools.has("read") ? "allow" : "deny",
          edit: canEdit ? artifactEditPermissions() : "deny",
          glob: tools.has("glob") ? "allow" : "deny",
          grep: tools.has("grep") ? "allow" : "deny",
          StructuredOutput: "allow",
          bash: "deny",
          task: "deny",
          skill: "deny",
          lsp: "deny",
          question: "deny",
          webfetch: "deny",
          websearch: "deny",
          external_directory: "deny",
        },
      },
    },
  };
}

function artifactEditPermissions(): Record<string, "allow" | "deny"> {
  const permissions: Record<string, "allow" | "deny"> = { "*": "deny" };
  for (const extension of artifactExtensions)
    permissions[`*${extension}`] = "allow";
  permissions[".*"] = "deny";
  permissions["*/.*"] = "deny";
  for (const name of runtimeInstructionNames) {
    permissions[name] = "deny";
    permissions[`*/${name}`] = "deny";
  }
  permissions["AGENTS.md"] = "deny";
  permissions["*/AGENTS.md"] = "deny";
  permissions["CLAUDE.md"] = "deny";
  permissions["*/CLAUDE.md"] = "deny";
  return permissions;
}

export function nativeTools(agent: Agent): Record<string, boolean> {
  const tools = new Set(agent.tools.map((tool) => tool.toLowerCase()));
  return {
    read: tools.has("read"),
    write: tools.has("write"),
    edit: tools.has("edit"),
    patch: false,
    apply_patch: false,
    glob: tools.has("glob"),
    grep: tools.has("grep"),
    list: false,
    bash: false,
    task: false,
    skill: false,
    lsp: false,
    webfetch: false,
    websearch: false,
    StructuredOutput: true,
  };
}

export function parseModel(model: string): { provider: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1)
    throw new Error(`Model must use provider/model format: ${model}`);
  return { provider: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export function providerKeyName(provider: string): string {
  const name = providerEnvironment[provider];
  if (!name)
    throw new Error(
      `Unsupported provider ${provider}; choose anthropic, openai, google, or openrouter`,
    );
  return name;
}

function providerKey(provider: string): string | undefined {
  return process.env[providerKeyName(provider)];
}

async function writeInputFiles(
  workspace: string,
  files: Record<string, string>,
) {
  let bytes = 0;
  for (const [name, content] of Object.entries(files)) {
    const target = safeWorkspacePath(workspace, name);
    bytes += Buffer.byteLength(content);
    if (bytes > maximumArtifactBytes)
      throw new Error("Input artifact exceeds 8 MiB");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o600 });
  }
}

async function readOutputFiles(
  workspace: string,
): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  let bytes = 0;
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink())
        throw new Error(
          `Output artifact contains a symlink: ${relative(workspace, path)}`,
        );
      if (info.isDirectory()) await visit(path);
      if (!info.isFile()) continue;
      validateArtifactName(relative(workspace, path));
      bytes += info.size;
      if (bytes > maximumArtifactBytes)
        throw new Error("Output artifact exceeds 8 MiB");
      output[relative(workspace, path)] = await readFile(path, "utf8");
    }
  }
  await visit(workspace);
  return output;
}

function safeWorkspacePath(workspace: string, name: string): string {
  if (!name || name.includes("\0"))
    throw new Error("Artifact path is empty or invalid");
  validateArtifactName(name);
  const target = resolve(workspace, name);
  if (target !== workspace && !target.startsWith(`${workspace}${sep}`))
    throw new Error(`Artifact path escapes workspace: ${name}`);
  return target;
}

export function validateArtifactName(name: string) {
  const parts = name.split(/[\\/]/);
  if (parts.some((part) => !part || part.startsWith(".")))
    throw new Error(
      `Artifact path contains a hidden or empty segment: ${name}`,
    );
  if (runtimeInstructionNames.has(parts.at(-1)!.toLowerCase()))
    throw new Error(
      `Artifact path is reserved for runtime instructions: ${name}`,
    );
  if (!artifactExtensions.has(extname(parts.at(-1)!).toLowerCase()))
    throw new Error(`Artifact type is not allowed: ${name}`);
}

async function waitForPort(
  container: string,
  signal?: AbortSignal,
): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (signal?.aborted) throw abortError();
    const result = await command("docker", ["port", container, "4096/tcp"], {
      timeoutMs: 3_000,
    }).catch(() => "");
    const match = result.match(/:(\d+)\s*$/m);
    if (match) return Number(match[1]);
    await delay(100);
  }
  throw new Error("Runtime container did not publish its API port");
}

async function waitForHealth(
  baseUrl: string,
  password: string,
  signal?: AbortSignal,
) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (signal?.aborted) throw abortError();
    try {
      const health = await api<{ healthy: boolean; version: string }>(
        baseUrl,
        password,
        "/global/health",
        { signal: boundedSignal(signal, 1_000) },
      );
      if (health.healthy && health.version === runtimeVersion) return;
      if (health.version !== runtimeVersion)
        throw new Error(
          `Expected OpenCode ${runtimeVersion}, got ${health.version}`,
        );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Expected OpenCode")
      )
        throw error;
    }
    await delay(150);
  }
  throw new Error("Runtime API did not become healthy");
}

function boundedSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function streamEvents(
  baseUrl: string,
  password: string,
  input: ExecuteTurnInput,
  sessionID: string,
  maxCostUsd: number,
  onCostLimit: () => void,
  parentSignal?: AbortSignal,
) {
  const controller = new AbortController();
  const assistantCosts = new Map<string, number>();
  const assistantMessages = new Map<string, SessionMessage>();
  let resolveIdle!: () => void;
  const idle = new Promise<void>((resolvePromise) => {
    resolveIdle = resolvePromise;
  });
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolvePromise) => {
    resolveReady = resolvePromise;
  });
  let idleSeen = false;
  let disconnected = false;
  const abort = () => controller.abort();
  parentSignal?.addEventListener("abort", abort, { once: true });
  void (async () => {
    try {
      const response = await fetch(`${baseUrl}/event`, {
        headers: authHeaders(password),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (data) {
            try {
              const event = JSON.parse(data) as { type?: string };
              emit(input, "runtime", event.type ?? "runtime event", event);
              const properties = Reflect.get(event, "properties");
              if (event.type === "server.connected") resolveReady();
              if (
                event.type === "session.idle" &&
                properties &&
                typeof properties === "object" &&
                Reflect.get(properties, "sessionID") === sessionID
              ) {
                idleSeen = true;
                resolveIdle();
              }
              captureAssistantMessage(assistantMessages, event, sessionID);
              const observedCost = observeAssistantCost(
                assistantCosts,
                event,
                sessionID,
              );
              if (observedCost !== null && observedCost >= maxCostUsd)
                onCostLimit();
            } catch {
              /* Ignore SSE comments and partial non-JSON events. */
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!controller.signal.aborted)
        emit(input, "status", "Runtime event stream closed", String(error));
    } finally {
      if (!controller.signal.aborted) disconnected = true;
      parentSignal?.removeEventListener("abort", abort);
    }
  })();
  return {
    abort: () => controller.abort(),
    idle,
    ready,
    completeUsage(expectedMessageID?: string): RuntimeUsage | null {
      if (!idleSeen || disconnected || !assistantMessages.size) return null;
      if (expectedMessageID && !assistantMessages.has(expectedMessageID))
        return null;
      const messages = [...assistantMessages.values()];
      const complete = messages.every((message) => {
        const info = message.info;
        const tokens = info?.tokens;
        return (
          typeof info?.cost === "number" &&
          Number.isFinite(info.cost) &&
          typeof info.time?.completed === "number" &&
          typeof tokens?.input === "number" &&
          typeof tokens.output === "number" &&
          typeof tokens.reasoning === "number" &&
          typeof tokens.cache?.read === "number" &&
          typeof tokens.cache.write === "number"
        );
      });
      return complete ? aggregateRuntimeUsage(messages) : null;
    },
  };
}

function captureAssistantMessage(
  messages: Map<string, SessionMessage>,
  event: unknown,
  sessionID: string,
) {
  if (!event || typeof event !== "object") return;
  if (Reflect.get(event, "type") !== "message.updated") return;
  const properties = Reflect.get(event, "properties");
  if (!properties || typeof properties !== "object") return;
  const info = Reflect.get(properties, "info");
  if (!info || typeof info !== "object") return;
  if (
    Reflect.get(info, "role") !== "assistant" ||
    Reflect.get(info, "sessionID") !== sessionID
  )
    return;
  const id = Reflect.get(info, "id");
  if (typeof id === "string")
    messages.set(id, { info: info as SessionMessage["info"] });
}

function sanitizedError(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown error";
  return message
    .replace(/Basic\s+[A-Za-z0-9+/=_-]+/gi, "Basic [redacted]")
    .slice(0, 400);
}

async function api<T>(
  baseUrl: string,
  password: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...authHeaders(password),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok)
    throw new Error(
      `OpenCode API ${response.status} ${path}: ${(await response.text()).slice(0, 500)}`,
    );
  return (await response.json()) as T;
}

function authHeaders(password: string): Record<string, string> {
  return {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  };
}

function parseStructured(value: unknown): { summary: string; outcome: string } {
  if (!value || typeof value !== "object")
    throw new Error("OpenCode returned no structured result");
  const summary = Reflect.get(value, "summary");
  const outcome = Reflect.get(value, "outcome");
  if (
    typeof summary !== "string" ||
    typeof outcome !== "string" ||
    !outcome.trim()
  )
    throw new Error("OpenCode returned an invalid structured result");
  return { summary, outcome: outcome.trim() };
}

function emit(
  input: ExecuteTurnInput,
  kind: RuntimeEvent["kind"],
  content: string,
  detail?: unknown,
) {
  try {
    const pending = input.onEvent?.({ kind, content, detail });
    if (pending) void Promise.resolve(pending).catch(() => undefined);
  } catch {
    /* Monitoring cannot own execution. */
  }
}

function command(
  executable: string,
  args: string[],
  options: { timeoutMs: number },
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout.trim());
      else
        reject(
          new Error(
            `${executable} ${args[0] ?? ""} failed (${code}): ${stderr.trim().slice(0, 500)}`,
          ),
        );
    });
  });
}

function delay(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function abortError() {
  return new DOMException("Runtime turn aborted", "AbortError");
}
