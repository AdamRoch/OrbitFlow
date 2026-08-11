import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  insertMessage,
  type JsonObject,
  type JsonValue,
  type Queryable,
} from "../postgres/message-bus.ts";
import { parseAgentGuardrails } from "../guardrails.ts";

export const EXPECTED_OPENCLAW_VERSION = "2026.4.15";
export const DEFAULT_OPENCLAW_WAKE_TIMEOUT_MS = 5 * 60 * 1_000;

const MAX_OPENCLAW_WAKE_TIMEOUT_MS = 30 * 60 * 1_000;
const MIN_OPENCLAW_WAKE_TIMEOUT_MS = 50;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const OPENCLAW_REF = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OPENCLAW_GATEWAY_ENVIRONMENT = new Set([
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
]);
const FIXED_OUTPUT_CONTRACT =
  '{"artifact":{},"handoff_brief":"string","events":[]}';

/** FACT-23 lists the enforced blocked-action boundary inside every wake prompt. */
function blockedActionLines(guardrails: unknown): string[] {
  const { blockedActions } = parseAgentGuardrails(guardrails);
  if (blockedActions.length === 0) {
    return ["No platform tool actions are blocked for this agent."];
  }
  return [
    "The platform tool surface rejects these actions for this agent; never attempt them:",
    ...blockedActions.map((action) => `- ${action}`),
  ];
}

type ErrorCode =
  | "agent_not_found"
  | "run_not_found"
  | "ticket_context_invalid"
  | "openclaw_version_mismatch"
  | "openclaw_configuration_failed"
  | "openclaw_turn_failed"
  | "openclaw_timeout"
  | "openclaw_malformed_output"
  | "openclaw_usage_invalid"
  | "openclaw_session_mismatch"
  | "openclaw_terminated"
  | "openclaw_termination_failed"
  | "openclaw_invocation_conflict"
  | "openclaw_invocation_indeterminate"
  | "runtime_persistence_failed";

export class RuntimeAdapterError extends Error {
  readonly code: ErrorCode;
  readonly safeDetails: JsonObject;

  constructor(
    code: ErrorCode,
    message: string,
    safeDetails: JsonObject = {},
  ) {
    super(message);
    this.name = "RuntimeAdapterError";
    this.code = code;
    this.safeDetails = safeDetails;
  }
}

class MalformedOutputError extends RuntimeAdapterError {
  constructor(message: string) {
    super("openclaw_malformed_output", message);
    this.name = "MalformedOutputError";
  }
}

interface AgentRow extends QueryResultRow {
  id: string;
  name: string;
  role: string;
  system_prompt: string;
  model: string;
  guardrails: JsonObject;
  interaction_rules: JsonObject;
  memory: JsonObject;
  openclaw_ref: string | null;
}

interface RunRow extends QueryResultRow {
  id: string;
  status: string;
  trigger_type: string;
  spec: JsonObject;
  workflow_id: string;
  workflow_name: string;
  workflow_description: string;
}

interface TicketRow extends QueryResultRow {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  status: string;
  priority: number;
}

export interface RuntimeOutput {
  artifact: JsonObject;
  handoff_brief: string;
  events: JsonObject[];
}

export interface RuntimeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  computedCost: string;
}

export interface RuntimeCompletion {
  status: string;
  exitCode: number;
  sessionId: string | null;
  provider: string | null;
  model: string;
}

export interface WakeAgentInput {
  runId: string | number | bigint;
  agentId: string | number | bigint;
  invocationId: string;
  nodeId: string;
  nodeSystemPrompt: string;
  ticketIds?: readonly (string | number | bigint)[];
  upstreamHandoffBrief?: string | null;
  timeoutMs?: number;
  workspaceTools?: string | null;
}

export interface WakeAgentResult {
  output: RuntimeOutput;
  usage: RuntimeUsage;
  completion: RuntimeCompletion;
  attempts: number;
  costEventId: string;
  replayed: boolean;
}

export interface SynchronizedAgent {
  agentId: string;
  openclawRef: string;
  workspace: string;
  created: boolean;
}

export interface RuntimeAdapterOptions {
  pool: Pool;
  runtimeRoot: string;
  openClawCommand?: string;
  openClawCommandArguments?: readonly string[];
  expectedOpenClawVersion?: string;
  wakeTimeoutMs?: number;
  terminationGraceMs?: number;
  gatewayEnvironment?: Readonly<Record<string, string | undefined>>;
  allowedExecEnvironment?: readonly string[];
}

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stderrBytes: number;
  timedOut: boolean;
  terminated: boolean;
}

interface RunningCommand {
  child: ChildProcess;
  closed: Promise<void>;
  sessionKey?: string;
}

interface ParsedTurn {
  output: RuntimeOutput;
  usage: RuntimeUsage;
  completion: Omit<RuntimeCompletion, "model"> & { model: string | null };
  embedded: boolean;
}

interface RuntimeInvocation {
  invocationKey: string;
  requestFingerprint: string;
  costEventId: string;
}

interface InvocationReceiptRow extends QueryResultRow {
  payload: JsonObject;
}

function positiveId(value: string | number | bigint, field: string): string {
  const normalized = String(value);
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return normalized;
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-blank string`);
  }
  return value.trim();
}

function timeout(value: number | undefined, fallback: number): number {
  const chosen = value ?? fallback;
  if (
    !Number.isSafeInteger(chosen) ||
    chosen < MIN_OPENCLAW_WAKE_TIMEOUT_MS ||
    chosen > MAX_OPENCLAW_WAKE_TIMEOUT_MS
  ) {
    throw new RangeError(
      `timeoutMs must be an integer from ${MIN_OPENCLAW_WAKE_TIMEOUT_MS} to ${MAX_OPENCLAW_WAKE_TIMEOUT_MS}`,
    );
  }
  return chosen;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonObject(value: unknown, field: string): JsonObject {
  if (!isObject(value)) throw new MalformedOutputError(`${field} must be a JSON object`);
  return value as JsonObject;
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] as JsonValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJsonDocument(primary: string, fallback?: string, stderrBytes?: number): unknown {
  for (const text of [primary, fallback].filter((t): t is string => typeof t === "string" && t.length > 0)) {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const first = lines[index].trimStart()[0];
      if (first !== "{" && first !== "[") continue;
      try {
        return JSON.parse(lines.slice(index).join("\n").trim());
      } catch {
        // OpenClaw may print a diagnostic before its JSON document.
      }
    }
  }
  const tail = (primary || fallback || "").slice(-500).replace(/\n/g, "\\n");
  throw new RuntimeAdapterError(
    "openclaw_turn_failed",
    `OpenClaw did not emit a JSON document (primary=${primary.length}, fallback=${(fallback || "").length}, stderrBytes=${stderrBytes ?? "?"}, tail=${tail.slice(-200)})`,
  );
}

function parseOutputContract(text: unknown, attempt: number): RuntimeOutput {
  if (typeof text !== "string" || text.trim() === "") {
    throw new MalformedOutputError("OpenClaw completed without a final output");
  }

  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // On the retry, strip markdown fences before rejecting
    if (attempt === 2) {
      const fenceStart = trimmed.match(/^`{3,}\w*\s*\n/);
      if (fenceStart) {
        let inner = trimmed.slice(fenceStart[0].length);
        const fenceEnd = inner.lastIndexOf("\n```");
        if (fenceEnd !== -1) inner = inner.slice(0, fenceEnd).trim();
        try {
          parsed = JSON.parse(inner);
        } catch {
          throw new MalformedOutputError("Agent final output is not strict JSON");
        }
      } else {
        throw new MalformedOutputError("Agent final output is not strict JSON");
      }
    } else {
      throw new MalformedOutputError("Agent final output is not strict JSON");
    }
  }

  const output = jsonObject(parsed, "Agent final output");
  const keys = Object.keys(output).sort();
  if (keys.join(",") !== "artifact,events,handoff_brief") {
    throw new MalformedOutputError(
      "Agent final output must contain exactly artifact, handoff_brief, and events",
    );
  }
  const artifact = jsonObject(output.artifact, "Agent output artifact");
  if (typeof output.handoff_brief !== "string" || output.handoff_brief.trim() === "") {
    throw new MalformedOutputError("Agent output handoff_brief must be a non-blank string");
  }
  if (!Array.isArray(output.events) || output.events.some((event) => !isObject(event))) {
    throw new MalformedOutputError("Agent output events must be an array of JSON objects");
  }

  return {
    artifact,
    handoff_brief: output.handoff_brief,
    events: output.events as JsonObject[],
  };
}

function usageInteger(value: unknown, field: string, optional = false): number {
  if (value === undefined && optional) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeAdapterError(
      "openclaw_usage_invalid",
      `OpenClaw returned invalid usage.${field}`,
    );
  }
  return value;
}

function decimal(value: unknown): string {
  if (value === undefined || value === null) return "0";
  const normalized = typeof value === "number" ? String(value) : String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized) || !Number.isFinite(Number(normalized))) {
    throw new RuntimeAdapterError(
      "openclaw_usage_invalid",
      "OpenClaw returned invalid usage cost",
    );
  }
  return normalized;
}

function normalizeUsage(raw: unknown): RuntimeUsage {
  if (!isObject(raw)) {
    throw new RuntimeAdapterError(
      "openclaw_usage_invalid",
      "OpenClaw omitted per-turn token usage",
    );
  }
  const input = usageInteger(raw.input, "input");
  const output = usageInteger(raw.output, "output");
  const cacheRead = usageInteger(raw.cacheRead, "cacheRead", true);
  const cacheWrite = usageInteger(raw.cacheWrite, "cacheWrite", true);
  const total = usageInteger(raw.total, "total");
  if (total === 0 || total < input + output) {
    throw new RuntimeAdapterError(
      "openclaw_usage_invalid",
      "OpenClaw returned inconsistent or zero total tokens",
    );
  }
  const cost = isObject(raw.cost) ? raw.cost.total : undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    computedCost: decimal(cost),
  };
}

function parseTurn(result: CommandResult, attempt: number): ParsedTurn {
  if (result.timedOut) {
    throw new RuntimeAdapterError("openclaw_timeout", "OpenClaw wake timed out", {
      signal: result.signal,
    });
  }
  if (result.terminated) {
    throw new RuntimeAdapterError("openclaw_terminated", "OpenClaw wake was terminated", {
      signal: result.signal,
    });
  }

  let envelope = parseJsonDocument(result.stdout, result.stderr, result.stderrBytes);
  if (!isObject(envelope)) {
    throw new RuntimeAdapterError("openclaw_turn_failed", "OpenClaw envelope must be an object");
  }

  let embedded = false;
  if (
    !Object.hasOwn(envelope, "status") &&
    !Object.hasOwn(envelope, "result") &&
    Array.isArray(envelope.payloads) &&
    isObject(envelope.meta)
  ) {
    embedded = true;
    const sessionId =
      isObject(envelope.meta.agentMeta) &&
      typeof envelope.meta.agentMeta.sessionId === "string"
        ? envelope.meta.agentMeta.sessionId
        : `embedded-${createHash("sha256").update(result.stdout.slice(0, 4096)).digest("hex").slice(0, 16)}`;
    envelope = {
      status: "ok",
      summary: "completed",
      runId: sessionId,
      result: envelope,
    };
  }

  const turn = isObject(envelope.result) ? envelope.result : null;
  const meta = turn && isObject(turn.meta) ? turn.meta : null;
  const completion = meta && isObject(meta.completion) ? meta.completion : null;
  const agentMeta = meta && isObject(meta.agentMeta) ? meta.agentMeta : null;
  const payloads = turn && Array.isArray(turn.payloads) ? turn.payloads : null;
  const textPayloads = payloads?.filter(
    (p) => isObject(p) && p.mediaUrl === null && typeof p.text === "string",
  ) ?? [];
  const firstPayload = textPayloads.length >= 1 ? textPayloads[textPayloads.length - 1] : null;

  const isCompletedStop =
    envelope.status === "ok" &&
    envelope.summary === "completed" &&
    meta &&
    meta.aborted === false &&
    meta.livenessState === "working" &&
    meta.stopReason === "stop";

  if (isCompletedStop && !firstPayload && attempt === 1) {
    throw new MalformedOutputError(
      "Agent completed its turn without a text payload; retry should prompt for the output contract",
    );
  }
  const envelopeKeys = Object.keys(envelope).sort().join(",");
  const turnKeys = turn ? Object.keys(turn).sort().join(",") : "";
  const payloadKeys = firstPayload ? Object.keys(firstPayload).sort().join(",") : "";
  if (
    result.exitCode !== 0 ||
    envelopeKeys !== "result,runId,status,summary" ||
    envelope.status !== "ok" ||
    envelope.summary !== "completed" ||
    typeof envelope.runId !== "string" ||
    envelope.runId.trim() === "" ||
    !turn ||
    !meta ||
    !completion ||
    !agentMeta ||
    !firstPayload ||
    turnKeys !== "meta,payloads" ||
    payloadKeys !== "mediaUrl,text" ||
    firstPayload.mediaUrl !== null ||
    meta.aborted !== false ||
    meta.replayInvalid !== false ||
    meta.livenessState !== "working" ||
    meta.stopReason !== "stop" ||
    completion.stopReason !== "stop" ||
    completion.finishReason !== "stop" ||
    typeof agentMeta.sessionId !== "string" ||
    agentMeta.sessionId.trim() === "" ||
    typeof agentMeta.provider !== "string" ||
    agentMeta.provider.trim() === "" ||
    typeof agentMeta.model !== "string" ||
    agentMeta.model.trim() === "" ||
    Object.hasOwn(meta, "error")
  ) {
    const diag: JsonObject = {
      exitCode: result.exitCode,
      envelopeKeys,
      status: typeof envelope.status === "string" ? envelope.status : null,
      summary: typeof envelope.summary === "string" ? envelope.summary : null,
      runIdType: typeof envelope.runId,
      hasTurn: !!turn,
      hasMeta: !!meta,
      hasCompletion: !!completion,
      hasAgentMeta: !!agentMeta,
      hasFirstPayload: !!firstPayload,
    };
    if (turn) diag.turnKeys = turnKeys;
    if (firstPayload) {
      diag.payloadKeys = payloadKeys;
      diag.mediaUrl = firstPayload.mediaUrl;
    }
    if (meta) {
      diag.hasErrorField = Object.hasOwn(meta, "error");
      if (typeof meta.aborted !== "undefined") diag.metaAborted = meta.aborted;
      if (typeof meta.replayInvalid !== "undefined") diag.metaReplayInvalid = meta.replayInvalid;
      if (typeof meta.livenessState === "string") diag.metaLivenessState = meta.livenessState;
      if (typeof meta.stopReason === "string") diag.metaStopReason = meta.stopReason;
    }
    if (completion) {
      if (typeof completion.stopReason === "string") diag.compStopReason = completion.stopReason;
      if (typeof completion.finishReason === "string") diag.compFinishReason = completion.finishReason;
    }
    if (agentMeta) {
      diag.agSessionId = typeof agentMeta.sessionId;
      diag.agProvider = typeof agentMeta.provider;
      diag.agModel = typeof agentMeta.model;
    }
    throw new RuntimeAdapterError(
      "openclaw_turn_failed",
      "OpenClaw 2026.4.15 gateway turn envelope did not complete",
      {
        exitCode: result.exitCode,
        status: typeof envelope.status === "string" ? envelope.status : null,
        livenessState:
          meta && typeof meta.livenessState === "string" ? meta.livenessState : null,
        stopReason: meta && typeof meta.stopReason === "string" ? meta.stopReason : null,
        diagnostics: diag,
      },
    );
  }
  return {
    output: parseOutputContract(firstPayload.text, attempt),
    usage: normalizeUsage(agentMeta.usage),
    completion: {
      status: "stop",
      exitCode: 0,
      sessionId: agentMeta.sessionId,
      provider: agentMeta.provider,
      model: agentMeta.model,
    },
    embedded,
  };
}

function openClawRef(agent: AgentRow): string {
  const candidate = agent.openclaw_ref ?? `orbitflow-${agent.id}`;
  if (!OPENCLAW_REF.test(candidate)) {
    throw new RuntimeAdapterError(
      "openclaw_configuration_failed",
      "Agent openclaw_ref is not a safe OpenClaw identifier",
      { agentId: agent.id },
    );
  }
  return candidate;
}

function runtimeSession(ref: string, input: WakeAgentInput, invocationId: string): {
  sessionId: string;
  sessionKey: string;
} {
  const ticketIds = [...(input.ticketIds ?? [])].map(String).sort();
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        runId: String(input.runId),
        agentId: String(input.agentId),
        invocationId,
        nodeId: input.nodeId,
        ticketIds,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  const sessionId = `orbitflow-${digest}`;
  return { sessionId, sessionKey: `agent:${ref}:main` };
}

function runtimeInvocation(
  input: WakeAgentInput,
  runId: string,
  agentId: string,
  invocationId: string,
): RuntimeInvocation {
  const invocationKey = createHash("sha256")
    .update(stableJson({ runId, agentId, invocationId }))
    .digest("hex");
  const requestFingerprint = createHash("sha256")
    .update(
      stableJson({
        nodeId: input.nodeId,
        nodeSystemPrompt: input.nodeSystemPrompt,
        ticketIds: [...(input.ticketIds ?? [])].map(String).sort(),
        upstreamHandoffBrief: input.upstreamHandoffBrief ?? null,
      }),
    )
    .digest("hex");
  const positive =
    (BigInt(`0x${invocationKey.slice(0, 16)}`) &
      ((BigInt(1) << BigInt(63)) - BigInt(1))) +
    BigInt(1);
  return { invocationKey, requestFingerprint, costEventId: (-positive).toString() };
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function safeBaseEnvironment(runtimeRoot: string, extraNames: readonly string[] = []): NodeJS.ProcessEnv {
  const allowed = ["LANG", "LC_ALL", "PATH", "TMPDIR", "TZ", ...extraNames] as const;
  return {
    ...(Object.fromEntries(
      allowed.flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]],
      ),
    ) as NodeJS.ProcessEnv),
    HOME: path.join(runtimeRoot, "home"),
    XDG_CACHE_HOME: path.join(runtimeRoot, "home", ".cache"),
    XDG_CONFIG_HOME: path.join(runtimeRoot, "home", ".config"),
    XDG_DATA_HOME: path.join(runtimeRoot, "home", ".local", "share"),
  };
}

function safeError(error: unknown): RuntimeAdapterError {
  if (error instanceof RuntimeAdapterError) return error;
  return new RuntimeAdapterError("openclaw_turn_failed", "OpenClaw runtime operation failed", {
    errorName: error instanceof Error ? error.name : "unknown",
  });
}

function storedUsage(value: unknown): RuntimeUsage {
  if (!isObject(value)) {
    throw new RuntimeAdapterError(
      "runtime_persistence_failed",
      "Stored OpenClaw invocation usage is invalid",
    );
  }
  const input = usageInteger(value.input, "input");
  const output = usageInteger(value.output, "output");
  const cacheRead = usageInteger(value.cacheRead, "cacheRead");
  const cacheWrite = usageInteger(value.cacheWrite, "cacheWrite");
  const total = usageInteger(value.total, "total");
  if (total === 0 || total < input + output) {
    throw new RuntimeAdapterError(
      "runtime_persistence_failed",
      "Stored OpenClaw invocation usage is inconsistent",
    );
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    computedCost: decimal(value.computedCost),
  };
}

function storedCompletion(value: unknown): RuntimeCompletion {
  if (
    !isObject(value) ||
    value.status !== "stop" ||
    value.exitCode !== 0 ||
    typeof value.sessionId !== "string" ||
    value.sessionId.trim() === "" ||
    (value.provider !== null && typeof value.provider !== "string") ||
    typeof value.model !== "string" ||
    value.model.trim() === ""
  ) {
    throw new RuntimeAdapterError(
      "runtime_persistence_failed",
      "Stored OpenClaw invocation completion is invalid",
    );
  }
  return value as unknown as RuntimeCompletion;
}

function storedAttempts(value: unknown): number {
  if (value !== 1 && value !== 2) {
    throw new RuntimeAdapterError(
      "runtime_persistence_failed",
      "Stored OpenClaw invocation attempt count is invalid",
    );
  }
  return value;
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && [
    "agent_not_found",
    "run_not_found",
    "ticket_context_invalid",
    "openclaw_version_mismatch",
    "openclaw_configuration_failed",
    "openclaw_turn_failed",
    "openclaw_timeout",
    "openclaw_malformed_output",
    "openclaw_usage_invalid",
    "openclaw_session_mismatch",
    "openclaw_terminated",
    "openclaw_termination_failed",
    "openclaw_invocation_conflict",
    "openclaw_invocation_indeterminate",
    "runtime_persistence_failed",
  ].includes(value);
}

export class OpenClawRuntimeAdapter {
  private readonly pool: Pool;
  private readonly runtimeRoot: string;
  private readonly stateDirectory: string;
  private readonly command: string;
  private readonly commandArguments: readonly string[];
  private readonly expectedVersion: string;
  private readonly wakeTimeoutMs: number;
  private readonly terminationGraceMs: number;
  private readonly gatewayEnvironment: Readonly<Record<string, string | undefined>>;
  private readonly allowedExecEnvironment: readonly string[];
  private readonly activeCommands = new Map<string, Set<RunningCommand>>();
  private readonly externallyTerminatedCommands = new WeakSet<ChildProcess>();
  private versionProof: Promise<void> | null = null;
  private configurationTail: Promise<void> = Promise.resolve();

  constructor(options: RuntimeAdapterOptions) {
    this.pool = options.pool;
    this.runtimeRoot = path.resolve(options.runtimeRoot);
    this.stateDirectory = path.join(this.runtimeRoot, "state");
    this.command = options.openClawCommand ?? "openclaw";
    this.commandArguments = options.openClawCommandArguments ?? [];
    this.expectedVersion = options.expectedOpenClawVersion ?? EXPECTED_OPENCLAW_VERSION;
    this.wakeTimeoutMs = timeout(options.wakeTimeoutMs, DEFAULT_OPENCLAW_WAKE_TIMEOUT_MS);
    this.terminationGraceMs = timeout(
      options.terminationGraceMs,
      DEFAULT_TERMINATION_GRACE_MS,
    );
    this.gatewayEnvironment = options.gatewayEnvironment ?? {};
    this.allowedExecEnvironment = options.allowedExecEnvironment ?? [];
    const rejectedEnvironment = Object.keys(this.gatewayEnvironment).filter(
      (name) => !OPENCLAW_GATEWAY_ENVIRONMENT.has(name),
    );
    if (rejectedEnvironment.length > 0) {
      throw new TypeError(
        `gatewayEnvironment contains unsupported variables: ${rejectedEnvironment.sort().join(", ")}`,
      );
    }
  }

  async syncAgent(agentIdValue: string | number | bigint): Promise<SynchronizedAgent> {
    const agentId = positiveId(agentIdValue, "agentId");
    return await this.withConfigurationLock(async () => {
      await this.ensureVersion();
      const agent = await this.loadAgent(agentId);
      return await this.syncAgentRow(agent);
    });
  }

  async wakeAgent(input: WakeAgentInput): Promise<WakeAgentResult> {
    const runId = positiveId(input.runId, "runId");
    const agentId = positiveId(input.agentId, "agentId");
    const invocationId = nonBlank(input.invocationId, "invocationId");
    const nodeId = nonBlank(input.nodeId, "nodeId");
    const nodeSystemPrompt = nonBlank(input.nodeSystemPrompt, "nodeSystemPrompt");
    const wakeTimeoutMs = timeout(input.timeoutMs, this.wakeTimeoutMs);
    const normalizedInput: WakeAgentInput = {
      ...input,
      runId,
      agentId,
      invocationId,
      nodeId,
      nodeSystemPrompt,
    };
    const context = await this.loadContext(runId, agentId, input.ticketIds);
    const invocation = runtimeInvocation(normalizedInput, runId, agentId, invocationId);
    const ref = openClawRef(context.agent);
    const session = runtimeSession(ref, normalizedInput, invocationId);

    return await this.withInvocationLock(invocation.invocationKey, async (client) => {
      const reserved = await this.reserveInvocation(client, {
        ...invocation,
        runId,
        agentId,
        model: context.agent.model,
      });
      if (!reserved) {
        return await this.replayInvocation(client, {
          ...invocation,
          runId,
          agentId,
          ticketId: context.tickets.length === 1 ? context.tickets[0].id : null,
          ref,
        });
      }

      let attempts = 0;
      try {
        const synchronized = await this.withConfigurationLock(async () => {
          await this.ensureVersion();
          return await this.syncAgentRow(context.agent, client, input.workspaceTools ?? null);
        });
        const prompt = this.composePrompt({
          invocationId,
          nodeId,
          nodeSystemPrompt,
          agent: context.agent,
          run: context.run,
          tickets: context.tickets,
          upstreamHandoffBrief: input.upstreamHandoffBrief ?? null,
        });
        for (;;) {
          attempts += 1;
          const commandTimeoutSeconds = Math.max(1, Math.ceil(wakeTimeoutMs / 1_000));
          const deliveredPrompt =
            attempts === 1
              ? prompt
              : `${prompt}\n\n# Structured-output retry\nYour previous response did not satisfy the fixed output contract. This is the only retry. Return only the required strict JSON object.`;
          const result = await this.runCommand(
            [
              "agent",
              "--agent",
              synchronized.openclawRef,
              "--session-id",
              session.sessionId,
              "--message",
              deliveredPrompt,
              "--timeout",
              String(commandTimeoutSeconds),
              "--json",
            ],
            {
              timeoutMs: wakeTimeoutMs,
              activeAgentRef: synchronized.openclawRef,
              activeSessionKey: session.sessionKey,
            },
          );
          try {
            const parsed = parseTurn(result, attempts);
            if (!parsed.embedded) {
              await this.verifySessionIdentity(
                synchronized.openclawRef,
                session,
                parsed.completion.sessionId,
              );
            }
            const completion: RuntimeCompletion = {
              ...parsed.completion,
              model: parsed.completion.model ?? context.agent.model,
            };
            return await this.persistSuccessfulInvocation(client, {
              ...invocation,
              runId,
              agentId,
              ticketId: context.tickets.length === 1 ? context.tickets[0].id : null,
              attempts,
              output: parsed.output,
              usage: parsed.usage,
              completion,
            });
          } catch (error) {
            if (error instanceof MalformedOutputError && attempts === 1) continue;
            throw error;
          }
        }
      } catch (error) {
        let runtimeError = safeError(error);
        try {
          await this.terminateRef(
            ref,
            runtimeError.code === "openclaw_timeout" ||
              runtimeError.code === "openclaw_terminated" ||
              runtimeError.code === "openclaw_session_mismatch"
              ? session.sessionKey
              : null,
          );
        } catch (terminationError) {
          runtimeError = new RuntimeAdapterError(
            "openclaw_termination_failed",
            "OpenClaw wake failed and its gateway session could not be confirmed aborted",
            {
              originalErrorCode: runtimeError.code,
              terminationErrorName:
                terminationError instanceof Error ? terminationError.name : "unknown",
            },
          );
        }
        await this.persistSystemError(client, {
          ...invocation,
          runId,
          agentId,
          ticketId: context.tickets.length === 1 ? context.tickets[0].id : null,
          ref,
          attempts,
          error: runtimeError,
        });
        throw runtimeError;
      }
    });
  }

  async terminateAgent(agentIdValue: string | number | bigint): Promise<void> {
    const agentId = positiveId(agentIdValue, "agentId");
    const result = await this.pool.query<Pick<AgentRow, "openclaw_ref">>(
      "SELECT openclaw_ref FROM agents WHERE id = $1",
      [agentId],
    );
    const ref = result.rows[0]?.openclaw_ref;
    if (!ref) return;
    await this.terminateRef(ref);
  }

  private async loadAgent(agentId: string): Promise<AgentRow> {
    const result = await this.pool.query<AgentRow>(
      `SELECT id::text, name, role, system_prompt, model, guardrails,
              interaction_rules, memory, openclaw_ref
       FROM agents WHERE id = $1`,
      [agentId],
    );
    const agent = result.rows[0];
    if (!agent) {
      throw new RuntimeAdapterError("agent_not_found", "Runtime agent does not exist", {
        agentId,
      });
    }
    return agent;
  }

  private async syncAgentRow(
    agent: AgentRow,
    database: Queryable = this.pool,
    workspaceTools: string | null = null,
  ): Promise<SynchronizedAgent> {
    const ref = openClawRef(agent);
    const workspace = path.join(this.runtimeRoot, "workspaces", ref);
    await this.writeWorkspace(workspace, agent, workspaceTools);

    const listed = await this.requireJsonCommand(["agents", "list", "--json"]);
    const entries = Array.isArray(listed)
      ? listed
      : isObject(listed) && Array.isArray(listed.agents)
        ? listed.agents
        : [];
    const index = entries.findIndex((entry) => isObject(entry) && entry.id === ref);
    const created = index === -1;
    if (created) {
      await this.requireJsonCommand([
        "agents",
        "add",
        ref,
        "--workspace",
        workspace,
        "--model",
        agent.model,
        "--non-interactive",
        "--json",
      ]);
    } else {
      const configured = await this.requireJsonCommand([
        "config",
        "get",
        "agents.list",
        "--json",
      ]);
      if (!Array.isArray(configured)) {
        throw new RuntimeAdapterError(
          "openclaw_configuration_failed",
          "OpenClaw agents.list configuration is not an array",
          { agentId: agent.id },
        );
      }
      const configuredIndex = configured.findIndex(
        (entry) => isObject(entry) && entry.id === ref,
      );
      if (configuredIndex === -1) {
        throw new RuntimeAdapterError(
          "openclaw_configuration_failed",
          "OpenClaw listed the agent without a mutable agents.list entry",
          { agentId: agent.id },
        );
      }
      const entry = configured[configuredIndex];
      const configuredWorkspace = isObject(entry) ? String(entry.workspace ?? "") : "";
      const configuredModel = isObject(entry) ? String(entry.model ?? "") : "";
      if (configuredWorkspace !== workspace) {
        await this.requireCommand([
          "config",
          "set",
          `agents.list[${configuredIndex}].workspace`,
          JSON.stringify(workspace),
          "--strict-json",
        ]);
      }
      if (configuredModel !== agent.model) {
        await this.requireCommand([
          "config",
          "set",
          `agents.list[${configuredIndex}].model`,
          JSON.stringify(agent.model),
          "--strict-json",
        ]);
      }
    }
    await this.requireJsonCommand([
      "agents",
      "set-identity",
      "--agent",
      ref,
      "--identity-file",
      path.join(workspace, "IDENTITY.md"),
      "--json",
    ]);

    const persisted = await database.query(
      `UPDATE agents
       SET openclaw_ref = $2,
           updated_at = CASE WHEN openclaw_ref IS DISTINCT FROM $2 THEN now() ELSE updated_at END
       WHERE id = $1 AND (openclaw_ref IS NULL OR openclaw_ref = $2)
       RETURNING id`,
      [agent.id, ref],
    );
    if (persisted.rowCount !== 1) {
      throw new RuntimeAdapterError(
        "openclaw_configuration_failed",
        "Agent OpenClaw reference changed during synchronization",
        { agentId: agent.id },
      );
    }
    return { agentId: agent.id, openclawRef: ref, workspace, created };
  }

  private async loadContext(
    runId: string,
    agentId: string,
    requestedTicketIds: readonly (string | number | bigint)[] | undefined,
  ): Promise<{ agent: AgentRow; run: RunRow; tickets: TicketRow[] }> {
    const [agent, runResult] = await Promise.all([
      this.loadAgent(agentId),
      this.pool.query<RunRow>(
        `SELECT r.id::text, r.status::text, r.trigger_type::text, r.spec,
                w.id::text AS workflow_id, w.name AS workflow_name,
                w.description AS workflow_description
         FROM workflow_runs r
         JOIN workflows w ON w.id = r.workflow_id
         WHERE r.id = $1`,
        [runId],
      ),
    ]);
    const run = runResult.rows[0];
    if (!run) {
      throw new RuntimeAdapterError("run_not_found", "Calling workflow run does not exist", {
        runId,
      });
    }

    const ticketIds = requestedTicketIds?.map((id) => positiveId(id, "ticketId"));
    const ticketsResult = await this.pool.query<TicketRow>(
      `SELECT id::text, identifier, title, description, acceptance_criteria,
              status::text, priority
       FROM tickets
       WHERE run_id = $1
         AND assignee_agent_id = $2
         AND ($3::bigint[] IS NULL OR id = ANY($3::bigint[]))
       ORDER BY priority DESC, created_at, id`,
      [runId, agentId, ticketIds ?? null],
    );
    if (ticketIds && ticketsResult.rows.length !== new Set(ticketIds).size) {
      throw new RuntimeAdapterError(
        "ticket_context_invalid",
        "Every requested ticket must belong to the calling run and agent",
        { runId, agentId },
      );
    }
    return { agent, run, tickets: ticketsResult.rows };
  }

  private composePrompt(input: {
    invocationId: string;
    nodeId: string;
    nodeSystemPrompt: string;
    agent: AgentRow;
    run: RunRow;
    tickets: TicketRow[];
    upstreamHandoffBrief: string | null;
  }): string {
    const workflowContext: JsonObject = {
      workflow: {
        id: input.run.workflow_id,
        name: input.run.workflow_name,
        description: input.run.workflow_description,
      },
      run: {
        id: input.run.id,
        status: input.run.status,
        triggerType: input.run.trigger_type,
        spec: input.run.spec,
      },
      node: { id: input.nodeId, invocationId: input.invocationId },
      agent: { id: input.agent.id, name: input.agent.name, role: input.agent.role },
    };
    const tickets = input.tickets.map((ticket) => ({
      id: ticket.id,
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptance_criteria,
      status: ticket.status,
      priority: ticket.priority,
    }));
    return [
      "# Node system prompt",
      input.nodeSystemPrompt,
      "",
      "# Workflow and run context",
      stableJson(workflowContext),
      "",
      "# Assigned tickets",
      stableJson(tickets),
      "",
      "# Upstream handoff brief",
      input.upstreamHandoffBrief?.trim() || "No upstream handoff brief was supplied.",
      "",
      "# Canonical agent memory",
      "This is the current PostgreSQL-owned memory snapshot. Treat it as authoritative.",
      stableJson(input.agent.memory),
      "",
      "# Blocked actions",
      ...blockedActionLines(input.agent.guardrails),
      "",
      "# Fixed output contract",
      `Return only strict JSON matching ${FIXED_OUTPUT_CONTRACT}.`,
      "artifact must be a JSON object, handoff_brief must be a non-blank string, and every events entry must be a JSON object.",
      "Do not wrap the JSON in Markdown fences and do not add top-level fields.",
    ].join("\n");
  }

  private async writeWorkspace(workspace: string, agent: AgentRow, workspaceTools: string | null = null): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const toolsContent = workspaceTools?.trim()
      || "# Tools\n\nUse only tools allowed by the delivered node prompt.\n";
    const files: Record<string, string> = {
      "AGENTS.md":
        "Read SOUL.md and MEMORY.md before every turn. Follow the delivery prompt and return its fixed output contract exactly.\n",
      "SOUL.md": `${agent.system_prompt.trim()}\n`,
      "IDENTITY.md": `# ${agent.name}\n\n- Name: ${agent.name}\n- Role: ${agent.role}\n`,
      "MEMORY.md": [
        "# Canonical OrbitFlow memory",
        "",
        "Generated from PostgreSQL at wake time. Local edits are not authoritative.",
        "",
        "```json",
        JSON.stringify(agent.memory, null, 2),
        "```",
        "",
      ].join("\n"),
      "USER.md": "# User\n\nOrbitFlow delivers bounded workflow-node prompts.\n",
      "TOOLS.md": toolsContent,
      "HEARTBEAT.md": "# Heartbeat\n\nOrbitFlow owns scheduling and wake delivery.\n",
    };
    await Promise.all(
      Object.entries(files).map(async ([name, contents]) => {
        const target = path.join(workspace, name);
        const temporary = path.join(workspace, `.${name}.${process.pid}.tmp`);
        await writeFile(temporary, contents, { mode: 0o600 });
        await rename(temporary, target);
      }),
    );
  }

  private async verifySessionIdentity(
    ref: string,
    requested: { sessionId: string; sessionKey: string },
    returnedSessionId: string | null,
  ): Promise<void> {
    if (
      typeof returnedSessionId !== "string" ||
      returnedSessionId.trim() === "" ||
      returnedSessionId !== requested.sessionId
    ) {
      throw new RuntimeAdapterError(
        "openclaw_session_mismatch",
        "OpenClaw returned output with an invalid sessionId",
        { requestedSessionId: requested.sessionId },
      );
    }
    const result = await this.runCommand(
      ["sessions", "--agent", ref, "--json"],
      { timeoutMs: 30_000 },
    );
    const payload =
      !result.timedOut && result.exitCode === 0
        ? parseJsonDocument(result.stdout)
        : null;
    const sessions = isObject(payload) && Array.isArray(payload.sessions)
      ? payload.sessions
      : [];
    const matches = sessions.filter(
      (session) =>
        isObject(session) &&
        typeof session.sessionId === "string" &&
        session.sessionId === returnedSessionId,
    );
    if (matches.length !== 1) {
      throw new RuntimeAdapterError(
        "openclaw_session_mismatch",
        `Expected one OpenClaw session with id ${returnedSessionId}; found ${matches.length}`,
        { requestedSessionId: requested.sessionId },
      );
    }
  }

  private async withInvocationLock<T>(
    invocationKey: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    const lockName = `orbitflow:openclaw-invocation:${invocationKey}`;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockName]);
      return await operation(client);
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockName]);
      } finally {
        client.release();
      }
    }
  }

  private async reserveInvocation(
    client: PoolClient,
    input: RuntimeInvocation & {
      runId: string;
      agentId: string;
      model: string;
    },
  ): Promise<boolean> {
    const reservationModel = `orbitflow-invocation:${input.invocationKey}`;
    const result = await client.query(
      `INSERT INTO cost_events (
         id, run_id, agent_id, model, tokens_in, tokens_out, computed_cost
       ) VALUES ($1, $2, $3, $4, 0, 0, 0)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [input.costEventId, input.runId, input.agentId, reservationModel],
    );
    if (result.rowCount === 1) return true;

    const existing = await client.query<{
      run_id: string;
      agent_id: string;
      model: string;
    }>(
      `SELECT run_id::text, agent_id::text, model
       FROM cost_events WHERE id = $1`,
      [input.costEventId],
    );
    const row = existing.rows[0];
    if (!row || row.run_id !== input.runId || row.agent_id !== input.agentId) {
      throw new RuntimeAdapterError(
        "openclaw_invocation_conflict",
        "Durable OpenClaw invocation key conflicts with another attribution record",
      );
    }
    return false;
  }

  private async invocationReceipts(
    client: PoolClient,
    runId: string,
    invocationKey: string,
  ): Promise<InvocationReceiptRow[]> {
    const result = await client.query<InvocationReceiptRow>(
      `SELECT payload
       FROM messages
       WHERE run_id = $1
         AND sender = 'runtime:openclaw'
         AND payload->>'invocationKey' = $2
         AND payload->>'kind' IN (
           'openclaw_invocation_result',
           'openclaw_invocation_error'
         )
       ORDER BY id`,
      [runId, invocationKey],
    );
    return result.rows;
  }

  private async replayInvocation(
    client: PoolClient,
    input: RuntimeInvocation & {
      runId: string;
      agentId: string;
      ticketId: string | null;
      ref: string;
    },
  ): Promise<WakeAgentResult> {
    const receipts = await this.invocationReceipts(
      client,
      input.runId,
      input.invocationKey,
    );
    if (receipts.length > 1) {
      throw new RuntimeAdapterError(
        "runtime_persistence_failed",
        "Durable OpenClaw invocation has multiple terminal receipts",
      );
    }
    const receipt = receipts[0]?.payload;
    if (!receipt) {
      const error = new RuntimeAdapterError(
        "openclaw_invocation_indeterminate",
        "OpenClaw invocation was reserved but has no durable terminal result",
      );
      await this.persistSystemError(client, { ...input, attempts: 0, error });
      throw error;
    }
    if (receipt.requestFingerprint !== input.requestFingerprint) {
      throw new RuntimeAdapterError(
        "openclaw_invocation_conflict",
        "invocationId was reused with different OpenClaw wake input",
      );
    }
    if (receipt.kind === "openclaw_invocation_error") {
      if (!isErrorCode(receipt.code) || typeof receipt.message !== "string") {
        throw new RuntimeAdapterError(
          "runtime_persistence_failed",
          "Stored OpenClaw invocation error is invalid",
        );
      }
      throw new RuntimeAdapterError(receipt.code, receipt.message, { replayed: true });
    }
    if (
      receipt.kind !== "openclaw_invocation_result" ||
      receipt.costEventId !== input.costEventId
    ) {
      throw new RuntimeAdapterError(
        "runtime_persistence_failed",
        "Stored OpenClaw invocation result is invalid",
      );
    }
    return {
      output: parseOutputContract(JSON.stringify(receipt.output), storedAttempts(receipt.attempts)),
      usage: storedUsage(receipt.usage),
      completion: storedCompletion(receipt.completion),
      attempts: storedAttempts(receipt.attempts),
      costEventId: input.costEventId,
      replayed: true,
    };
  }

  private async persistSuccessfulInvocation(
    client: PoolClient,
    input: RuntimeInvocation & {
      runId: string;
      agentId: string;
      ticketId: string | null;
      attempts: number;
      output: RuntimeOutput;
      usage: RuntimeUsage;
      completion: RuntimeCompletion;
    },
  ): Promise<WakeAgentResult> {
    try {
      await client.query("BEGIN");
      const attributed = await client.query(
        `UPDATE cost_events
         SET model = $4,
             tokens_in = $5,
             tokens_out = $6,
             computed_cost = $7,
             updated_at = now()
         WHERE id = $1
           AND run_id = $2
           AND agent_id = $3
           AND model = $8`,
        [
          input.costEventId,
          input.runId,
          input.agentId,
          input.completion.model,
          input.usage.input,
          input.usage.output,
          input.usage.computedCost,
          `orbitflow-invocation:${input.invocationKey}`,
        ],
      );
      if (attributed.rowCount !== 1) throw new Error("invocation reservation changed");
      const updated = await client.query(
        `UPDATE workflow_runs
         SET total_tokens = total_tokens + $2,
             total_cost = total_cost + $3,
             updated_at = now()
         WHERE id = $1`,
        [input.runId, input.usage.total, input.usage.computedCost],
      );
      if (updated.rowCount !== 1) throw new Error("calling run disappeared");
      await insertMessage(client, {
        runId: input.runId,
        ticketId: input.ticketId,
        sender: "runtime:openclaw",
        recipient: "runtime:openclaw-replay",
        type: "system",
        payload: {
          kind: "openclaw_invocation_result",
          version: 1,
          state: "completed",
          invocationKey: input.invocationKey,
          requestFingerprint: input.requestFingerprint,
          costEventId: input.costEventId,
          attempts: input.attempts,
          output: {
            artifact: input.output.artifact,
            handoff_brief: input.output.handoff_brief,
            events: input.output.events,
          },
          usage: {
            input: input.usage.input,
            output: input.usage.output,
            cacheRead: input.usage.cacheRead,
            cacheWrite: input.usage.cacheWrite,
            total: input.usage.total,
            computedCost: input.usage.computedCost,
          },
          completion: {
            status: input.completion.status,
            exitCode: input.completion.exitCode,
            sessionId: input.completion.sessionId,
            provider: input.completion.provider,
            model: input.completion.model,
          },
        },
        handoffBrief: input.output.handoff_brief,
        tokenUsage: {
          input: input.usage.input,
          output: input.usage.output,
          cacheRead: input.usage.cacheRead,
          cacheWrite: input.usage.cacheWrite,
          total: input.usage.total,
          computedCost: input.usage.computedCost,
        },
      });
      await client.query("COMMIT");
      return {
        output: input.output,
        usage: input.usage,
        completion: input.completion,
        attempts: input.attempts,
        costEventId: input.costEventId,
        replayed: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw new RuntimeAdapterError(
        "runtime_persistence_failed",
        "OpenClaw completed but its durable result and usage could not be persisted",
        { errorName: error instanceof Error ? error.name : "unknown" },
      );
    }
  }

  private async persistSystemError(
    database: Queryable,
    input: RuntimeInvocation & {
      runId: string;
      agentId: string;
      ticketId: string | null;
      ref: string;
      attempts: number;
      error: RuntimeAdapterError;
    },
  ): Promise<void> {
    try {
      await insertMessage(database, {
        runId: input.runId,
        ticketId: input.ticketId,
        sender: "runtime:openclaw",
        recipient: "workflow-engine",
        type: "system",
        payload: {
          kind: "openclaw_invocation_error",
          version: 1,
          state: "failed",
          invocationKey: input.invocationKey,
          requestFingerprint: input.requestFingerprint,
          costEventId: input.costEventId,
          code: input.error.code,
          message: input.error.message,
          agentId: input.agentId,
          openclawRef: input.ref,
          attempts: input.attempts,
          failedAt: new Date().toISOString(),
          details: input.error.safeDetails,
        },
      });
    } catch (error) {
      throw new RuntimeAdapterError(
        "runtime_persistence_failed",
        "Runtime failure occurred and its durable system message could not be inserted",
        {
          runtimeErrorCode: input.error.code,
          persistenceErrorName: error instanceof Error ? error.name : "unknown",
        },
      );
    }
  }

  private async ensureVersion(): Promise<void> {
    this.versionProof ??= (async () => {
      const result = await this.runCommand(["--version"], { timeoutMs: 10_000 });
      const version = result.stdout.match(/(?:OpenClaw\s+)?(\d{4}\.\d+\.\d+)/)?.[1];
      if (result.exitCode !== 0 || version !== this.expectedVersion) {
        throw new RuntimeAdapterError(
          "openclaw_version_mismatch",
          `OpenClaw ${this.expectedVersion} is required`,
          { observedVersion: version ?? null },
        );
      }
    })();
    try {
      await this.versionProof;
    } catch (error) {
      this.versionProof = null;
      throw error;
    }
  }

  private async requireJsonCommand(arguments_: readonly string[]): Promise<unknown> {
    const result = await this.requireCommand(arguments_);
    return parseJsonDocument(result.stdout);
  }

  private async requireCommand(arguments_: readonly string[]): Promise<CommandResult> {
    const result = await this.runCommand(arguments_, { timeoutMs: 30_000 });
    if (result.timedOut || result.exitCode !== 0) {
      throw new RuntimeAdapterError(
        "openclaw_configuration_failed",
        "OpenClaw agent configuration command failed",
        {
          command: arguments_.slice(0, 2).join(" "),
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stderrBytes: result.stderrBytes,
        },
      );
    }
    return result;
  }

  private async runCommand(
    arguments_: readonly string[],
    options: {
      timeoutMs: number;
      activeAgentRef?: string;
      activeSessionKey?: string;
    },
  ): Promise<CommandResult> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.runtimeRoot, "home"), { recursive: true, mode: 0o700 });
    const environment: NodeJS.ProcessEnv = {
      ...safeBaseEnvironment(this.runtimeRoot, this.allowedExecEnvironment),
      ...Object.fromEntries(
        Object.entries(this.gatewayEnvironment).filter((entry): entry is [string, string] =>
          entry[1] !== undefined,
        ),
      ),
      OPENCLAW_STATE_DIR: this.stateDirectory,
      NO_COLOR: "1",
    };

    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(
        this.command,
        [...this.commandArguments, "--no-color", ...arguments_],
        {
          cwd: this.runtimeRoot,
          env: environment,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      let stderrBytes = 0;
      let timedOut = false;
      let terminated = false;
      let forceTimer: NodeJS.Timeout | undefined;
      let settled = false;
      let close!: () => void;
      const closed = new Promise<void>((closeResolve) => {
        close = closeResolve;
      });
      const running: RunningCommand = {
        child,
        closed,
        sessionKey: options.activeSessionKey,
      };
      const activeRef = options.activeAgentRef;
      if (activeRef) {
        const commands = this.activeCommands.get(activeRef) ?? new Set<RunningCommand>();
        commands.add(running);
        this.activeCommands.set(activeRef, commands);
      }

      const stop = (markTimeout: boolean) => {
        timedOut ||= markTimeout;
        terminated ||= !markTimeout;
        signalProcess(child, "SIGTERM");
        forceTimer ??= setTimeout(() => signalProcess(child, "SIGKILL"), this.terminationGraceMs);
      };
      const timer = setTimeout(() => stop(true), options.timeoutMs);

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > MAX_COMMAND_OUTPUT_BYTES) stop(false);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) stop(false);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        if (activeRef) {
          this.activeCommands.get(activeRef)?.delete(running);
          if (this.activeCommands.get(activeRef)?.size === 0) this.activeCommands.delete(activeRef);
        }
        this.externallyTerminatedCommands.delete(child);
        close();
        reject(
          new RuntimeAdapterError(
            "openclaw_turn_failed",
            "OpenClaw process could not be started",
            { errorName: error.name },
          ),
        );
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        if (activeRef) {
          this.activeCommands.get(activeRef)?.delete(running);
          if (this.activeCommands.get(activeRef)?.size === 0) this.activeCommands.delete(activeRef);
        }
        const externallyTerminated = this.externallyTerminatedCommands.has(child);
        this.externallyTerminatedCommands.delete(child);
        close();
        resolve({
          exitCode,
          signal,
          stdout,
          stderr,
          stderrBytes,
          timedOut,
          terminated: terminated || externallyTerminated,
        });
      });
    });
  }

  private async stopCommand(command: RunningCommand): Promise<void> {
    this.externallyTerminatedCommands.add(command.child);
    signalProcess(command.child, "SIGTERM");
    const force = setTimeout(
      () => signalProcess(command.child, "SIGKILL"),
      this.terminationGraceMs,
    );
    await command.closed;
    clearTimeout(force);
  }

  private async terminateRef(ref: string, additionalSessionKey: string | null = null): Promise<void> {
    const commands = [...(this.activeCommands.get(ref) ?? [])];
    await Promise.all(commands.map((command) => this.stopCommand(command)));
    const sessionKeys = new Set(
      commands.flatMap((command) => (command.sessionKey ? [command.sessionKey] : [])),
    );
    if (additionalSessionKey) sessionKeys.add(additionalSessionKey);
    await Promise.all([...sessionKeys].map((sessionKey) => this.abortSession(sessionKey)));
  }

  private async abortSession(sessionKey: string): Promise<void> {
    const result = await this.runCommand(
      [
        "gateway",
        "call",
        "sessions.abort",
        "--params",
        JSON.stringify({ key: sessionKey }),
        "--timeout",
        "5000",
        "--json",
      ],
      { timeoutMs: 7_000 },
    );
    if (result.timedOut || result.exitCode !== 0) {
      throw new RuntimeAdapterError(
        "openclaw_termination_failed",
        "OpenClaw gateway session abort command failed",
        {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stderrBytes: result.stderrBytes,
        },
      );
    }
    const payload = parseJsonDocument(result.stdout);
    if (
      !isObject(payload) ||
      payload.ok !== true ||
      (payload.status !== "aborted" && payload.status !== "no-active-run")
    ) {
      throw new RuntimeAdapterError(
        "openclaw_termination_failed",
        "OpenClaw gateway did not confirm session termination",
      );
    }
  }

  private async withConfigurationLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.configurationTail.then(operation, operation);
    this.configurationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }
}
