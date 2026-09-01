import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  insertMessage,
  type JsonObject,
  type JsonValue,
  type Queryable,
} from "../postgres/message-bus.ts";
import { parseAgentGuardrails } from "../guardrails.ts";
import { writeOpenClawWorkspace } from "./openclaw-workspace.ts";

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
  "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
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
  | "openclaw_session_lock_timeout"
  | "openclaw_session_lock_unavailable"
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
  agentModel?: string;
  dispatchGeneration?: string | number | bigint;
  dispatchSessionId?: string;
  toolContext?: JsonObject | null;
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
  runtimeUrl?: string;
  runtimeToken?: string;
  availableModels?: readonly string[];
  retryMalformedOutput?: boolean;
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
  runId?: string;
}

interface ParsedTurn {
  output: RuntimeOutput;
  usage: RuntimeUsage;
  completion: Omit<RuntimeCompletion, "model"> & { model: string | null };
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

function parseJsonDocument(primary: string): unknown {
  for (const text of [primary].filter((t): t is string => typeof t === "string" && t.length > 0)) {
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
  throw new RuntimeAdapterError(
    "openclaw_turn_failed",
    "OpenClaw did not emit a JSON document",
    { stdoutBytes: Buffer.byteLength(primary) },
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

function normalizeUsage(raw: unknown, rawLastCall: unknown): RuntimeUsage {
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
  const reportedTotal = usageInteger(raw.total, "total");
  const completeStreamTotal = input + output + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(completeStreamTotal)) {
    throw new RuntimeAdapterError(
      "openclaw_usage_invalid",
      "OpenClaw usage totals exceeded the safe integer range",
    );
  }
  let total = reportedTotal;
  if (reportedTotal < completeStreamTotal && isObject(rawLastCall)) {
    const lastInput = usageInteger(rawLastCall.input, "lastCallUsage.input", true);
    const lastOutput = usageInteger(rawLastCall.output, "lastCallUsage.output", true);
    const lastCacheRead = usageInteger(
      rawLastCall.cacheRead,
      "lastCallUsage.cacheRead",
      true,
    );
    const lastCacheWrite = usageInteger(
      rawLastCall.cacheWrite,
      "lastCallUsage.cacheWrite",
      true,
    );
    const lastTotal = usageInteger(rawLastCall.total, "lastCallUsage.total");
    const lastComponents = lastInput + lastOutput + lastCacheRead + lastCacheWrite;
    if (!Number.isSafeInteger(lastComponents)) {
      throw new RuntimeAdapterError(
        "openclaw_usage_invalid",
        "OpenClaw last-call usage exceeded the safe integer range",
      );
    }

    // OpenClaw 2026.4.15 accumulates the component fields across every model
    // call, but overwrites usage.total with the final call's total after a
    // tool-using turn. Accept only that exact, independently checkable shape.
    if (
      reportedTotal === lastTotal &&
      lastTotal >= lastComponents &&
      input >= lastInput &&
      output >= lastOutput &&
      cacheRead >= lastCacheRead &&
      cacheWrite >= lastCacheWrite
    ) {
      total = completeStreamTotal;
    }
  }
  if (total === 0 || total < completeStreamTotal) {
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

function parseTurn(
  result: CommandResult,
  attempt: number,
  expectedRunId: string,
): ParsedTurn {
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

  const parsedDocument = parseJsonDocument(result.stdout);
  if (!isObject(parsedDocument)) {
    throw new RuntimeAdapterError("openclaw_turn_failed", "OpenClaw envelope must be an object");
  }
  const envelope: Record<string, unknown> = parsedDocument;

  const turn = isObject(envelope.result) ? envelope.result : null;
  const meta = turn && isObject(turn.meta) ? turn.meta : null;
  const completion = meta && isObject(meta.completion) ? meta.completion : null;
  const agentMeta = meta && isObject(meta.agentMeta) ? meta.agentMeta : null;
  const payloads = turn && Array.isArray(turn.payloads) ? turn.payloads : null;
  const finalPayload = payloads?.filter(
    (payload): payload is Record<string, unknown> =>
      isObject(payload) && typeof payload.text === "string" && payload.text.trim() !== "",
  ).at(-1) ?? null;

  const envelopeKeys = Object.keys(envelope).sort().join(",");
  const turnKeys = turn ? Object.keys(turn).sort().join(",") : "";
  const payloadKeys = finalPayload ? Object.keys(finalPayload).sort().join(",") : "";
  const failEnvelope = (): never => {
    const diag: JsonObject = {
      exitCode: result.exitCode,
      envelopeHasExpectedKeys: envelopeKeys === "result,runId,status,summary",
      statusType: typeof envelope.status,
      summaryType: typeof envelope.summary,
      runIdType: typeof envelope.runId,
      runIdMatchesRequest: envelope.runId === expectedRunId,
      hasTurn: !!turn,
      hasMeta: !!meta,
      hasCompletion: !!completion,
      hasAgentMeta: !!agentMeta,
      payloadCount: payloads?.length ?? null,
      hasFinalPayload: !!finalPayload,
    };
    if (turn) diag.turnHasExpectedKeys = turnKeys === "meta,payloads";
    if (finalPayload) {
      diag.payloadHasExpectedKeys = payloadKeys === "mediaUrl,text";
      diag.mediaUrlType = typeof finalPayload.mediaUrl;
      diag.mediaUrlIsNull = finalPayload.mediaUrl === null;
    }
    if (meta) {
      diag.hasErrorField = Object.hasOwn(meta, "error");
      diag.metaAbortedIsFalse = meta.aborted === false;
      diag.metaReplayInvalidType = typeof meta.replayInvalid;
      diag.metaLivenessStateType = typeof meta.livenessState;
      diag.metaStopReasonType = typeof meta.stopReason;
    }
    if (completion) {
      diag.compStopReasonType = typeof completion.stopReason;
      diag.compFinishReasonType = typeof completion.finishReason;
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
        diagnostics: diag,
      },
    );
  };
  if (
    result.exitCode !== 0 ||
    envelopeKeys !== "result,runId,status,summary" ||
    envelope.status !== "ok" ||
    envelope.summary !== "completed" ||
    envelope.runId !== expectedRunId ||
    !turn ||
    !meta ||
    !completion ||
    !agentMeta ||
    turnKeys !== "meta,payloads" ||
    !payloads ||
    payloads.some((payload) =>
      !isObject(payload) ||
      Object.keys(payload).sort().join(",") !== "mediaUrl,text" ||
      typeof payload.text !== "string" ||
      payload.mediaUrl !== null
    ) ||
    meta.aborted !== false ||
    (Object.hasOwn(meta, "replayInvalid") && typeof meta.replayInvalid !== "boolean") ||
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
    failEnvelope();
  }

  const completedMeta = meta as Record<string, unknown>;
  const completedAgentMeta = agentMeta as Record<string, unknown>;
  const usage = normalizeUsage(
    completedAgentMeta.usage,
    completedAgentMeta.lastCallUsage,
  );
  if (!finalPayload) {
    if (completedMeta.replayInvalid === true) {
      throw new RuntimeAdapterError(
        "openclaw_turn_failed",
          "OpenClaw 2026.4.15 gateway turn produced mutating side effects (replayInvalid) without an output payload",
        {
          exitCode: result.exitCode,
          diagnostics: { hasFinalPayload: false, metaReplayInvalid: true },
        },
      );
    }
    if (attempt === 1) {
      throw new MalformedOutputError(
        "Agent completed its turn without a text payload; retry should prompt for the output contract",
      );
    }
    failEnvelope();
  }
  const payload = finalPayload;
  if (payload === null) return failEnvelope();

  let output: RuntimeOutput;
  try {
    output = parseOutputContract(payload.text, attempt);
  } catch (error) {
    if (error instanceof MalformedOutputError && completedMeta.replayInvalid === true) {
      throw new RuntimeAdapterError(
        "openclaw_turn_failed",
        "OpenClaw 2026.4.15 gateway turn produced mutating side effects (replayInvalid) with malformed output",
        { diagnostics: { hasFinalPayload: true, metaReplayInvalid: true } },
      );
    }
    throw error;
  }
  for (const earlierPayload of payloads.slice(0, payloads.lastIndexOf(finalPayload))) {
    if (!isObject(earlierPayload) || typeof earlierPayload.text !== "string" || !earlierPayload.text.trim()) {
      continue;
    }
    try {
      parseOutputContract(earlierPayload.text, attempt);
    } catch (error) {
      if (error instanceof MalformedOutputError) continue;
      throw error;
    }
    throw new RuntimeAdapterError(
      "openclaw_turn_failed",
      "OpenClaw 2026.4.15 gateway turn produced multiple valid output contracts",
      { diagnostics: { validContractCount: 2 } },
    );
  }
  return {
    output,
    usage,
    completion: {
      status: "stop",
      exitCode: 0,
      sessionId: completedAgentMeta.sessionId as string,
      provider: completedAgentMeta.provider as string,
      model: completedAgentMeta.model as string,
    },
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

function runtimeSession(ref: string, dispatchSessionId: string): { sessionKey: string } {
  return { sessionKey: `agent:${ref}:${dispatchSessionId}` };
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
        agentModel: input.agentModel ?? null,
        dispatchGeneration: input.dispatchGeneration === undefined
          ? null
          : String(input.dispatchGeneration),
        dispatchSessionId: input.dispatchSessionId ?? null,
        ticketIds: [...(input.ticketIds ?? [])].map(String).sort(),
        upstreamHandoffBrief: input.upstreamHandoffBrief ?? null,
        workspaceTools: input.workspaceTools ?? null,
        toolContext: input.toolContext ?? null,
      }),
    )
    .digest("hex");
  const positive =
    (BigInt(`0x${invocationKey.slice(0, 16)}`) &
      ((BigInt(1) << BigInt(63)) - BigInt(1))) +
    BigInt(1);
  return { invocationKey, requestFingerprint, costEventId: (-positive).toString() };
}

function gatewayTurnIdempotencyKey(invocationKey: string, attempt: number): string {
  return `orbitflow-${invocationKey.slice(0, 48)}-${attempt}`;
}

/**
 * FACT-30: stable advisory lock key for one exact canonical OpenClaw agent
 * ref, derived through SHA-256 and BigInt so JavaScript number precision never
 * truncates it. The digest is mapped into 1..2^63-1 so the key can never
 * overflow PostgreSQL's signed bigint. Returned as text for a `$1::bigint` bind.
 */
function agentSessionLockKey(ref: string): string {
  const digest = createHash("sha256")
    .update(`orbitflow:openclaw-agent-session:${ref}`)
    .digest("hex")
    .slice(0, 16);
  const modulus = (BigInt(1) << BigInt(63)) - BigInt(1);
  const positive = (BigInt(`0x${digest}`) % modulus) + BigInt(1);
  return positive.toString();
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

function safeBaseEnvironment(runtimeRoot: string): NodeJS.ProcessEnv {
  const allowed = ["LANG", "LC_ALL", "PATH", "TMPDIR", "TZ"] as const;
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
    "openclaw_session_lock_timeout",
    "openclaw_session_lock_unavailable",
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
  private readonly runtimeUrl: string | null;
  private readonly runtimeToken: string | null;
  private readonly availableModels: ReadonlySet<string> | null;
  private readonly retryMalformedOutput: boolean;
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
    this.runtimeUrl = options.runtimeUrl?.trim().replace(/\/$/, "") || null;
    this.runtimeToken = options.runtimeToken?.trim() || null;
    if ((this.runtimeUrl === null) !== (this.runtimeToken === null)) {
      throw new TypeError("runtimeUrl and runtimeToken must be supplied together");
    }
    if (this.runtimeUrl !== null) {
      const parsed = new URL(this.runtimeUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new TypeError("runtimeUrl must use http or https");
      }
    }
    this.availableModels = options.availableModels
      ? new Set(options.availableModels)
      : null;
    this.retryMalformedOutput = options.retryMalformedOutput ?? true;
    const rejectedEnvironment = Object.keys(this.gatewayEnvironment).filter(
      (name) => !OPENCLAW_GATEWAY_ENVIRONMENT.has(name),
    );
    if (rejectedEnvironment.length > 0) {
      throw new TypeError(
        `gatewayEnvironment contains unsupported variables: ${rejectedEnvironment.sort().join(", ")}`,
      );
    }
    const allowInsecurePrivateWs = this.gatewayEnvironment.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS;
    if (allowInsecurePrivateWs !== undefined && allowInsecurePrivateWs !== "1") {
      throw new TypeError("OPENCLAW_ALLOW_INSECURE_PRIVATE_WS must be exactly 1 when supplied");
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
    const agentModel = input.agentModel === undefined
      ? undefined
      : nonBlank(input.agentModel, "agentModel");
    const dispatchGeneration = input.dispatchGeneration === undefined
      ? undefined
      : positiveId(input.dispatchGeneration, "dispatchGeneration");
    const dispatchSessionId = input.dispatchSessionId === undefined
      ? undefined
      : nonBlank(input.dispatchSessionId, "dispatchSessionId");
    const wakeTimeoutMs = timeout(input.timeoutMs, this.wakeTimeoutMs);
    const normalizedInput: WakeAgentInput = {
      ...input,
      runId,
      agentId,
      invocationId,
      nodeId,
      nodeSystemPrompt,
      agentModel,
      dispatchGeneration,
      dispatchSessionId,
    };
    const context = await this.loadContext(runId, agentId, input.ticketIds);
    const runtimeAgent = agentModel === undefined
      ? context.agent
      : { ...context.agent, model: agentModel };
    this.requireAvailableModel(runtimeAgent);
    const invocation = runtimeInvocation(normalizedInput, runId, agentId, invocationId);
    const ref = openClawRef(runtimeAgent);
    const session = runtimeSession(ref, dispatchSessionId ?? invocationId);

    return await this.withInvocationLock(invocation.invocationKey, async (client) => {
      const reserved = await this.reserveInvocation(client, {
        ...invocation,
        runId,
        agentId,
        model: runtimeAgent.model,
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

      // Deterministic lock order: the per-invocation PostgreSQL advisory lock
      // is always taken first and the FACT-30 same-agent session lock second.
      // The holder of the agent session lock never takes a second PostgreSQL
      // advisory lock, so no wait cycle can form. The in-process configuration
      // promise queue only serializes this process's config edits; it is not a
      // distributed lock and does not participate in lock ordering.
      try {
        return await this.withAgentSessionLock(ref, wakeTimeoutMs, async (deadlineMs) => {
          let attempts = 0;
          let launchedGatewayRunId: string | null = null;
          try {
            const synchronized = await this.withConfigurationLock(async () => {
              await this.ensureVersion(deadlineMs);
              return await this.syncAgentRow(
                runtimeAgent,
                client,
                input.workspaceTools ?? null,
                input.toolContext ?? null,
                deadlineMs,
              );
            });
            const prompt = this.composePrompt({
              invocationId,
              nodeId,
              nodeSystemPrompt,
              workspaceTools: input.workspaceTools ?? null,
              agent: runtimeAgent,
              run: context.run,
              tickets: context.tickets,
              upstreamHandoffBrief: input.upstreamHandoffBrief ?? null,
            });
            for (;;) {
              attempts += 1;
              // End-to-end deadline: each attempt, including the one retry,
              // gets only the budget left after checkout, lock acquisition,
              // and configuration sync — never a fresh full timeout — and an
              // exhausted deadline refuses to launch another command at all.
              const commandTimeoutMs = this.commandBudget(
                deadlineMs,
                wakeTimeoutMs,
                "the OpenClaw agent command",
              );
              const commandTimeoutSeconds = Math.max(1, Math.ceil(commandTimeoutMs / 1_000));
              const deliveredPrompt =
                attempts === 1
                  ? prompt
                  : `${prompt}\n\n# Structured-output retry\nYour previous response was rejected because it included text or Markdown formatting outside the JSON object. This is the only retry. Do not repeat tool actions already completed in this session. Do not explain, apologize, or claim the previous response was valid. Your entire response must start with { and end with }. Return exactly one strict JSON object matching the fixed output contract.`;
              const gatewayRunId = gatewayTurnIdempotencyKey(
                invocation.invocationKey,
                attempts,
              );
              launchedGatewayRunId = gatewayRunId;
              const result = await this.runGatewayCall(
                "agent",
                {
                  message: deliveredPrompt,
                  agentId: synchronized.openclawRef,
                  sessionKey: session.sessionKey,
                  timeout: commandTimeoutSeconds,
                  deliver: false,
                  idempotencyKey: gatewayRunId,
                },
                {
                  timeoutMs: commandTimeoutMs,
                  expectFinal: true,
                  activeAgentRef: synchronized.openclawRef,
                  activeSessionKey: session.sessionKey,
                  activeRunId: gatewayRunId,
                },
              );
              try {
                const parsed = parseTurn(result, attempts, gatewayRunId);
                await this.verifySessionIdentity(
                  synchronized.openclawRef,
                  session.sessionKey,
                  parsed.completion.sessionId,
                  deadlineMs,
                );
                const completion: RuntimeCompletion = {
                  ...parsed.completion,
                  model: parsed.completion.model ?? runtimeAgent.model,
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
                if (
                  error instanceof MalformedOutputError &&
                  attempts === 1 &&
                  this.retryMalformedOutput
                ) continue;
                throw error;
              }
            }
          } catch (error) {
            let runtimeError = safeError(error);
            try {
              // Gateway cleanup only makes sense once an agent command really
              // launched; a wake refused by the exhausted deadline never
              // created gateway session state, so it must not abort anything.
              await this.terminateRef(
                ref,
                launchedGatewayRunId !== null &&
                  (runtimeError.code === "openclaw_timeout" ||
                    runtimeError.code === "openclaw_terminated" ||
                    runtimeError.code === "openclaw_session_mismatch")
                  ? { sessionKey: session.sessionKey, runId: launchedGatewayRunId }
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
      } catch (error) {
        if (
          error instanceof RuntimeAdapterError &&
          (error.code === "openclaw_session_lock_timeout" ||
            error.code === "openclaw_session_lock_unavailable")
        ) {
          await this.persistSystemError(client, {
            ...invocation,
            runId,
            agentId,
            ticketId: context.tickets.length === 1 ? context.tickets[0].id : null,
            ref,
            attempts: 0,
            error,
          });
        }
        throw error;
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
    this.requireAvailableModel(agent);
    return agent;
  }

  private requireAvailableModel(agent: Pick<AgentRow, "name" | "model">): void {
    if (this.availableModels && !this.availableModels.has(agent.model)) {
      throw new RuntimeAdapterError(
        "openclaw_configuration_failed",
        `Agent "${agent.name}" references unavailable OpenClaw model "${agent.model}"; registered models: ${[...this.availableModels].join(", ")}`,
        { agentName: agent.name, model: agent.model },
      );
    }
  }

  private async syncAgentRow(
    agent: AgentRow,
    database: Queryable = this.pool,
    workspaceTools: string | null = null,
    toolContext: JsonObject | null = null,
    deadlineMs?: number,
  ): Promise<SynchronizedAgent> {
    const ref = openClawRef(agent);
    const workspace = path.join(this.runtimeRoot, "workspaces", ref);
    let synchronized: SynchronizedAgent;
    if (this.runtimeUrl !== null) {
      const remote = await this.runtimeRequest(
        "/v1/sync-agent",
        {
          agent: {
            id: agent.id,
            name: agent.name,
            role: agent.role,
            system_prompt: agent.system_prompt,
            model: agent.model,
            memory: agent.memory,
          },
          openclawRef: ref,
          workspaceTools,
          toolContext,
        },
        this.commandBudget(deadlineMs, 30_000, "the OpenClaw workspace sync"),
      );
      if (
        !isObject(remote) ||
        remote.agentId !== agent.id ||
        remote.openclawRef !== ref ||
        typeof remote.workspace !== "string" ||
        typeof remote.created !== "boolean"
      ) {
        throw new RuntimeAdapterError(
          "openclaw_configuration_failed",
          "OpenClaw runtime returned an invalid workspace sync response",
          { agentId: agent.id },
        );
      }
      synchronized = remote as unknown as SynchronizedAgent;
    } else {
      await this.writeWorkspace(workspace, agent, workspaceTools, toolContext);

      const listed = await this.requireGatewayJson("agents.list", {}, deadlineMs);
      if (!isObject(listed) || !Array.isArray(listed.agents)) {
        throw new RuntimeAdapterError(
          "openclaw_configuration_failed",
          "OpenClaw gateway returned an invalid agents.list response",
          { agentId: agent.id },
        );
      }
      const entries = listed.agents;
      const index = entries.findIndex((entry) => isObject(entry) && entry.id === ref);
      const created = index === -1;
      if (created) {
        const createdAgent = await this.requireGatewayJson(
          "agents.create",
          { name: ref, workspace, model: agent.model },
          deadlineMs,
        );
        if (
          !isObject(createdAgent) ||
          createdAgent.ok !== true ||
          createdAgent.agentId !== ref
        ) {
          throw new RuntimeAdapterError(
            "openclaw_configuration_failed",
            "OpenClaw gateway returned an invalid agents.create response",
            { agentId: agent.id },
          );
        }
      }

      const entry = created ? null : entries[index];
      const configuredWorkspace = isObject(entry) && typeof entry.workspace === "string"
        ? entry.workspace
        : "";
      const configuredModel =
        isObject(entry) &&
        isObject(entry.model) &&
        typeof entry.model.primary === "string"
          ? entry.model.primary
          : "";
      const configuredName = isObject(entry) && typeof entry.name === "string"
        ? entry.name
        : isObject(entry) && isObject(entry.identity) && typeof entry.identity.name === "string"
          ? entry.identity.name
          : "";
      if (
        created ||
        configuredWorkspace !== workspace ||
        configuredModel !== agent.model ||
        configuredName !== agent.name
      ) {
        const updatedAgent = await this.requireGatewayJson(
          "agents.update",
          { agentId: ref, name: agent.name, workspace, model: agent.model },
          deadlineMs,
        );
        if (
          !isObject(updatedAgent) ||
          updatedAgent.ok !== true ||
          updatedAgent.agentId !== ref
        ) {
          throw new RuntimeAdapterError(
            "openclaw_configuration_failed",
            "OpenClaw gateway returned an invalid agents.update response",
            { agentId: agent.id },
          );
        }
      }
      synchronized = { agentId: agent.id, openclawRef: ref, workspace, created };
    }

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
    return synchronized;
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
    workspaceTools: string | null;
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
      ...(input.workspaceTools?.trim()
        ? ["# Platform tools", input.workspaceTools.trim(), ""]
        : []),
      "# Fixed output contract",
      `Return only strict JSON matching ${FIXED_OUTPUT_CONTRACT}.`,
      "artifact must be a JSON object, handoff_brief must be a non-blank string, and every events entry must be a JSON object.",
      "Do not wrap the JSON in Markdown fences and do not add top-level fields.",
    ].join("\n");
  }

  private async writeWorkspace(
    workspace: string,
    agent: AgentRow,
    workspaceTools: string | null = null,
    toolContext: JsonObject | null = null,
  ): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await writeOpenClawWorkspace(workspace, agent, workspaceTools, toolContext);
  }

  private async verifySessionIdentity(
    ref: string,
    requestedSessionKey: string,
    returnedSessionId: string | null,
    deadlineMs?: number,
  ): Promise<void> {
    if (
      typeof returnedSessionId !== "string" ||
      returnedSessionId.trim() === ""
    ) {
      throw new RuntimeAdapterError(
        "openclaw_session_mismatch",
        "OpenClaw returned output with an invalid sessionId",
      );
    }
    const result = await this.runGatewayCall(
      "sessions.resolve",
      { agentId: ref, sessionId: returnedSessionId },
      {
        timeoutMs: this.commandBudget(deadlineMs, 30_000, "session verification"),
      },
    );
    if (deadlineMs !== undefined && result.timedOut) {
      throw new RuntimeAdapterError(
        "openclaw_timeout",
        "OpenClaw session verification consumed the wake deadline",
      );
    }
    const payload = !result.timedOut && result.exitCode === 0
      ? parseJsonDocument(result.stdout)
      : null;
    if (
      !isObject(payload) ||
      payload.ok !== true ||
      payload.key !== requestedSessionKey
    ) {
      throw new RuntimeAdapterError(
        "openclaw_session_mismatch",
        "OpenClaw did not resolve the returned session to the requested session key",
        { returnedSessionIdType: typeof returnedSessionId },
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

  /**
   * Maps the shared wake deadline onto one nested external command. Without a
   * deadline the historical fixed cap applies. With one, an exhausted budget
   * refuses to launch and a live command gets only the remaining milliseconds,
   * so no nested command can hold the same-agent lock past its deadline.
   */
  private commandBudget(deadlineMs: number | undefined, capMs: number, what: string): number {
    if (deadlineMs === undefined) return capMs;
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs < 1) {
      throw new RuntimeAdapterError(
        "openclaw_timeout",
        `OpenClaw wake deadline was exhausted before ${what} could launch`,
      );
    }
    return Math.min(capMs, remainingMs);
  }

  /**
   * FACT-30: serializes the full OpenClaw wake session of one exact canonical
   * agent ref across processes with a PostgreSQL session-level advisory lock
   * held on a dedicated pool client. No ordinary application transaction stays
   * open across the external command, and different refs never contend.
   * The wake deadline is end-to-end for the session region: pool checkout and
   * lock acquisition (PostgreSQL lock_timeout, error 55P03) consume it, and
   * the operation receives the absolute deadline so every command attempt
   * spends only the remaining budget. Every acquisition-stage
   * failure is typed. The lock is always explicitly unlocked and the client's
   * lock_timeout reset before the client returns to the pool, and a failed
   * unlock destroys the client so a leaked lock can never survive checkout.
   */
  private async withAgentSessionLock<T>(
    ref: string,
    timeoutMs: number,
    operation: (deadlineMs: number) => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    const lockKey = agentSessionLockKey(ref);
    const acquisitionTimeout = (stage: string) =>
      new RuntimeAdapterError(
        "openclaw_session_lock_timeout",
        "Timed out waiting for the same-agent OpenClaw session lock",
        { openclawRef: ref, timeoutMs, stage },
      );
    let client: PoolClient | null = null;
    try {
      try {
        client = await this.connectBounded(ref, timeoutMs, deadline);
        const remaining = deadline - Date.now();
        if (remaining < 1) throw acquisitionTimeout("lock");
        await client.query("SELECT set_config('lock_timeout', $1, false)", [
          String(Math.floor(remaining)),
        ]);
        await client.query("SELECT pg_advisory_lock($1::bigint)", [lockKey]);
      } catch (error) {
        if (error instanceof RuntimeAdapterError) throw error;
        if ((error as { code?: string }).code === "55P03") {
          throw acquisitionTimeout("lock");
        }
        throw new RuntimeAdapterError(
          "openclaw_session_lock_unavailable",
          "PostgreSQL could not acquire the same-agent OpenClaw session lock",
          {
            openclawRef: ref,
            errorName: error instanceof Error ? error.name : "unknown",
          },
        );
      }
      return await operation(deadline);
    } finally {
      if (client) {
        try {
          await client.query(
            "SELECT pg_advisory_unlock($1::bigint), set_config('lock_timeout', '0', false)",
            [lockKey],
          );
          client.release();
        } catch (error) {
          client.release(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
  }

  /**
   * Bounds even the pool checkout by the wake deadline. A client that arrives
   * after the deadline fired is released again instead of leaking.
   */
  private async connectBounded(
    ref: string,
    timeoutMs: number,
    deadline: number,
  ): Promise<PoolClient> {
    const connecting = this.pool.connect();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        connecting,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              connecting.then(
                (late) => late.release(),
                () => undefined,
              );
              reject(
                new RuntimeAdapterError(
                  "openclaw_session_lock_timeout",
                  "Timed out waiting for the same-agent OpenClaw session lock",
                  { openclawRef: ref, timeoutMs, stage: "connect" },
                ),
              );
            },
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
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
        "OpenClaw invocation was reserved but has no durable terminal result; the external effect is uncertain, so the provider will not be called again",
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

  private async ensureVersion(deadlineMs?: number): Promise<void> {
    // The proof is cached per adapter; the caller's deadline only applies
    // while the (re)check is actually created, never to a settled cache entry.
    this.versionProof ??= (async () => {
      const result = await this.runCommand(["--version"], {
        timeoutMs: this.commandBudget(deadlineMs, 10_000, "the version check"),
      });
      if (deadlineMs !== undefined && result.timedOut) {
        throw new RuntimeAdapterError(
          "openclaw_timeout",
          "OpenClaw version check consumed the wake deadline",
        );
      }
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

  private async requireGatewayJson(
    method: string,
    params: JsonObject,
    deadlineMs?: number,
  ): Promise<unknown> {
    const result = await this.runGatewayCall(method, params, {
      timeoutMs: this.commandBudget(deadlineMs, 30_000, "a configuration command"),
    });
    if (result.timedOut && deadlineMs !== undefined) {
      throw new RuntimeAdapterError(
        "openclaw_timeout",
        "OpenClaw configuration command consumed the wake deadline",
        { method },
      );
    }
    if (result.timedOut || result.exitCode !== 0) {
      throw new RuntimeAdapterError(
        "openclaw_configuration_failed",
        "OpenClaw gateway configuration call failed",
        {
          method,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stderrBytes: result.stderrBytes,
        },
      );
    }
    try {
      return parseJsonDocument(result.stdout);
    } catch {
      throw new RuntimeAdapterError(
        "openclaw_configuration_failed",
        "OpenClaw gateway configuration call returned invalid JSON",
        { method, stderrBytes: result.stderrBytes },
      );
    }
  }

  private async runtimeRequest(
    requestPath: string,
    payload: JsonObject,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.runtimeUrl === null || this.runtimeToken === null) {
      throw new RuntimeAdapterError(
        "openclaw_configuration_failed",
        "OpenClaw runtime RPC is not configured",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 10_000);
    try {
      let response: Response;
      try {
        response = await fetch(`${this.runtimeUrl}${requestPath}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.runtimeToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new RuntimeAdapterError(
            "openclaw_timeout",
            "OpenClaw runtime RPC timed out",
            { requestPath },
          );
        }
        throw new RuntimeAdapterError(
          "openclaw_turn_failed",
          "OpenClaw runtime RPC could not be reached",
          { requestPath, errorName: error instanceof Error ? error.name : "unknown" },
        );
      }
      const responseText = await response.text();
      let envelope: unknown;
      try {
        envelope = JSON.parse(responseText);
      } catch {
        throw new RuntimeAdapterError(
          "openclaw_turn_failed",
          "OpenClaw runtime RPC returned malformed JSON",
          { requestPath, status: response.status },
        );
      }
      if (!response.ok || !isObject(envelope) || envelope.ok !== true) {
        throw new RuntimeAdapterError(
          "openclaw_turn_failed",
          "OpenClaw runtime RPC rejected the request",
          { requestPath, status: response.status },
        );
      }
      return envelope.result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async runGatewayCall(
    method: string,
    params: JsonObject,
    options: {
      timeoutMs: number;
      expectFinal?: boolean;
      activeAgentRef?: string;
      activeSessionKey?: string;
      activeRunId?: string;
    },
  ): Promise<CommandResult> {
    return await this.runCommand(
      [
        "gateway",
        "call",
        method,
        "--params",
        JSON.stringify(params),
        "--timeout",
        String(options.timeoutMs),
        "--json",
        ...(options.expectFinal ? ["--expect-final"] : []),
      ],
      options,
    );
  }

  private async runCommand(
    arguments_: readonly string[],
    options: {
      timeoutMs: number;
      activeAgentRef?: string;
      activeSessionKey?: string;
      activeRunId?: string;
    },
  ): Promise<CommandResult> {
    if (this.runtimeUrl !== null) {
      const remote = await this.runtimeRequest(
        "/v1/gateway",
        {
          arguments: [...arguments_],
          timeoutMs: options.timeoutMs,
          ...(options.activeAgentRef === undefined
            ? {}
            : { activeAgentRef: options.activeAgentRef }),
          ...(options.activeSessionKey === undefined
            ? {}
            : { activeSessionKey: options.activeSessionKey }),
          ...(options.activeRunId === undefined
            ? {}
            : { activeRunId: options.activeRunId }),
        },
        options.timeoutMs,
      );
      if (
        !isObject(remote) ||
        (remote.exitCode !== null && typeof remote.exitCode !== "number") ||
        (remote.signal !== null && typeof remote.signal !== "string") ||
        typeof remote.stdout !== "string" ||
        typeof remote.stderrBytes !== "number" ||
        typeof remote.timedOut !== "boolean" ||
        typeof remote.terminated !== "boolean"
      ) {
        throw new RuntimeAdapterError(
          "openclaw_turn_failed",
          "OpenClaw runtime returned an invalid command result",
        );
      }
      return {
        exitCode: remote.exitCode as number | null,
        signal: remote.signal as NodeJS.Signals | null,
        stdout: remote.stdout,
        stderr: "",
        stderrBytes: remote.stderrBytes,
        timedOut: remote.timedOut,
        terminated: remote.terminated,
      };
    }
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.runtimeRoot, "home"), { recursive: true, mode: 0o700 });
    const environment: NodeJS.ProcessEnv = {
      ...safeBaseEnvironment(this.runtimeRoot),
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
        runId: options.activeRunId,
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

  private async terminateRef(
    ref: string,
    additionalSession: { sessionKey: string; runId: string } | null = null,
  ): Promise<void> {
    const commands = [...(this.activeCommands.get(ref) ?? [])];
    await Promise.all(commands.map((command) => this.stopCommand(command)));
    const sessionTargets = new Map<string, string>();
    for (const command of commands) {
      if (command.sessionKey && command.runId) {
        sessionTargets.set(command.sessionKey, command.runId);
      }
    }
    if (additionalSession) {
      sessionTargets.set(additionalSession.sessionKey, additionalSession.runId);
    }
    await Promise.all(
      [...sessionTargets].map(([sessionKey, runId]) => this.abortSession(sessionKey, runId)),
    );
  }

  private async abortSession(sessionKey: string, runId: string): Promise<void> {
    const result = await this.runGatewayCall(
      "sessions.abort",
      { key: sessionKey, runId },
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
    if (payload.status === "aborted" && payload.abortedRunId !== runId) {
      throw new RuntimeAdapterError(
        "openclaw_termination_failed",
        "OpenClaw gateway aborted a different run than the requested run",
        { abortedRunIdMatchesRequest: false },
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
