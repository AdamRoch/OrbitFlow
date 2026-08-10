import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool, QueryResultRow } from "pg";
import {
  insertMessage,
  type JsonObject,
  type JsonValue,
} from "../postgres/message-bus.ts";

export const EXPECTED_OPENCLAW_VERSION = "2026.4.15";
export const DEFAULT_OPENCLAW_WAKE_TIMEOUT_MS = 5 * 60 * 1_000;

const MAX_OPENCLAW_WAKE_TIMEOUT_MS = 30 * 60 * 1_000;
const MIN_OPENCLAW_WAKE_TIMEOUT_MS = 50;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const OPENCLAW_REF = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FIXED_OUTPUT_CONTRACT =
  '{"artifact":{},"handoff_brief":"string","events":[]}';

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
  | "openclaw_terminated"
  | "openclaw_termination_failed"
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
}

export interface WakeAgentResult {
  output: RuntimeOutput;
  usage: RuntimeUsage;
  completion: RuntimeCompletion;
  attempts: number;
  costEventId: string;
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
  providerEnvironment?: Readonly<Record<string, string | undefined>>;
}

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
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

function parseJsonDocument(text: string): unknown {
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
  throw new RuntimeAdapterError(
    "openclaw_turn_failed",
    "OpenClaw did not emit a JSON document",
  );
}

function parseOutputContract(text: unknown): RuntimeOutput {
  if (typeof text !== "string" || text.trim() === "") {
    throw new MalformedOutputError("OpenClaw completed without a final output");
  }

  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced ? fenced[1].trim() : trimmed);
  } catch {
    throw new MalformedOutputError("Agent final output is not strict JSON");
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

function usageInteger(value: unknown, field: string): number {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RuntimeAdapterError(
      "openclaw_usage_invalid",
      `OpenClaw returned invalid usage.${field}`,
    );
  }
  return number;
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
  const input = usageInteger(raw.input ?? raw.inputTokens, "input");
  const output = usageInteger(raw.output ?? raw.outputTokens, "output");
  const cacheRead = usageInteger(raw.cacheRead ?? raw.cacheReadTokens, "cacheRead");
  const cacheWrite = usageInteger(raw.cacheWrite ?? raw.cacheWriteTokens, "cacheWrite");
  const total = usageInteger(raw.total ?? input + output, "total");
  if (total === 0 || total < input + output) {
    throw new RuntimeAdapterError(
      "openclaw_usage_invalid",
      "OpenClaw returned inconsistent or zero total tokens",
    );
  }
  const cost = isObject(raw.cost) ? raw.cost.total ?? raw.cost.totalCost : undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    computedCost: decimal(raw.computedCost ?? raw.totalCost ?? cost),
  };
}

function parseTurn(result: CommandResult): ParsedTurn {
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

  const envelope = parseJsonDocument(result.stdout);
  if (!isObject(envelope)) {
    throw new RuntimeAdapterError("openclaw_turn_failed", "OpenClaw envelope must be an object");
  }

  if (Object.hasOwn(envelope, "ok") && Object.hasOwn(envelope, "status")) {
    if (result.exitCode !== 0 || envelope.ok !== true || envelope.status !== "ok") {
      throw new RuntimeAdapterError(
        "openclaw_turn_failed",
        "OpenClaw stable turn envelope did not complete",
        {
          exitCode: result.exitCode,
          status: typeof envelope.status === "string" ? envelope.status : null,
        },
      );
    }
    const payloads = Array.isArray(envelope.payloads) ? envelope.payloads : [];
    const firstPayload = isObject(payloads[0]) ? payloads[0] : {};
    return {
      output: parseOutputContract(envelope.final ?? firstPayload.text),
      usage: normalizeUsage(envelope.usage),
      completion: {
        status: "ok",
        exitCode: 0,
        sessionId: typeof envelope.sessionId === "string" ? envelope.sessionId : null,
        provider: typeof envelope.provider === "string" ? envelope.provider : null,
        model: typeof envelope.model === "string" ? envelope.model : null,
      },
    };
  }

  const meta = isObject(envelope.meta) ? envelope.meta : null;
  if (!meta) {
    throw new RuntimeAdapterError(
      "openclaw_turn_failed",
      "OpenClaw legacy turn envelope omitted meta",
    );
  }
  const completion = isObject(meta.completion) ? meta.completion : {};
  const stopReason = meta.stopReason ?? completion.finishReason ?? null;
  if (
    result.exitCode !== 0 ||
    meta.error ||
    meta.aborted === true ||
    meta.livenessState === "blocked" ||
    stopReason !== "stop"
  ) {
    throw new RuntimeAdapterError(
      "openclaw_turn_failed",
      "OpenClaw legacy turn envelope did not complete",
      {
        exitCode: result.exitCode,
        livenessState: typeof meta.livenessState === "string" ? meta.livenessState : null,
        stopReason: typeof stopReason === "string" ? stopReason : null,
      },
    );
  }
  const payloads = Array.isArray(envelope.payloads) ? envelope.payloads : [];
  const firstPayload = isObject(payloads[0]) ? payloads[0] : {};
  const agentMeta = isObject(meta.agentMeta) ? meta.agentMeta : {};
  return {
    output: parseOutputContract(firstPayload.text),
    usage: normalizeUsage(agentMeta.usage ?? agentMeta.lastCallUsage),
    completion: {
      status: "stop",
      exitCode: 0,
      sessionId: typeof agentMeta.sessionId === "string" ? agentMeta.sessionId : null,
      provider: typeof agentMeta.provider === "string" ? agentMeta.provider : null,
      model: typeof agentMeta.model === "string" ? agentMeta.model : null,
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
  return { sessionId, sessionKey: `agent:${ref}:${sessionId}` };
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

function safeBaseEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TMPDIR", "TZ"] as const;
  return {
    ...(Object.fromEntries(
      allowed.flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]],
      ),
    ) as NodeJS.ProcessEnv),
    NODE_ENV: process.env.NODE_ENV,
  };
}

function safeError(error: unknown): RuntimeAdapterError {
  if (error instanceof RuntimeAdapterError) return error;
  return new RuntimeAdapterError("openclaw_turn_failed", "OpenClaw runtime operation failed", {
    errorName: error instanceof Error ? error.name : "unknown",
  });
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
  private readonly providerEnvironment: Readonly<Record<string, string | undefined>>;
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
    this.providerEnvironment = options.providerEnvironment ?? {};
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
    const context = await this.loadContext(runId, agentId, input.ticketIds);
    let synchronized: SynchronizedAgent | null = null;
    let sessionKey: string | null = null;
    let attempts = 0;
    try {
      synchronized = await this.withConfigurationLock(async () => {
        await this.ensureVersion();
        return await this.syncAgentRow(context.agent);
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
      const session = runtimeSession(synchronized.openclawRef, input, invocationId);
      sessionKey = session.sessionKey;
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
          const parsed = parseTurn(result);
          const completion: RuntimeCompletion = {
            ...parsed.completion,
            model: parsed.completion.model ?? context.agent.model,
          };
          const costEventId = await this.persistUsage({
            runId,
            agentId,
            model: completion.model,
            usage: parsed.usage,
          });
          return {
            output: parsed.output,
            usage: parsed.usage,
            completion,
            attempts,
            costEventId,
          };
        } catch (error) {
          if (error instanceof MalformedOutputError && attempts === 1) continue;
          throw error;
        }
      }
    } catch (error) {
      let runtimeError = safeError(error);
      const ref = synchronized?.openclawRef ?? openClawRef(context.agent);
      try {
        await this.terminateRef(
          ref,
          runtimeError.code === "openclaw_timeout" ||
            runtimeError.code === "openclaw_terminated"
            ? sessionKey
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
      await this.persistSystemError({
        runId,
        agentId,
        ticketId: context.tickets.length === 1 ? context.tickets[0].id : null,
        ref,
        attempts,
        error: runtimeError,
      });
      throw runtimeError;
    }
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

  private async syncAgentRow(agent: AgentRow): Promise<SynchronizedAgent> {
    const ref = openClawRef(agent);
    const workspace = path.join(this.runtimeRoot, "workspaces", ref);
    await this.writeWorkspace(workspace, agent);

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
      await this.requireCommand([
        "config",
        "set",
        `agents.list[${configuredIndex}].workspace`,
        JSON.stringify(workspace),
        "--strict-json",
      ]);
      await this.requireCommand([
        "config",
        "set",
        `agents.list[${configuredIndex}].model`,
        JSON.stringify(agent.model),
        "--strict-json",
      ]);
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

    const persisted = await this.pool.query(
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
      "# Fixed output contract",
      `Return only strict JSON matching ${FIXED_OUTPUT_CONTRACT}.`,
      "artifact must be a JSON object, handoff_brief must be a non-blank string, and every events entry must be a JSON object.",
      "Do not wrap the JSON in Markdown fences and do not add top-level fields.",
    ].join("\n");
  }

  private async writeWorkspace(workspace: string, agent: AgentRow): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(workspace, { recursive: true, mode: 0o700 });
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
      "TOOLS.md": "# Tools\n\nUse only tools allowed by the delivered node prompt.\n",
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

  private async persistUsage(input: {
    runId: string;
    agentId: string;
    model: string;
    usage: RuntimeUsage;
  }): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO cost_events (
           run_id, agent_id, model, tokens_in, tokens_out, computed_cost
         ) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id::text`,
        [
          input.runId,
          input.agentId,
          input.model,
          input.usage.input,
          input.usage.output,
          input.usage.computedCost,
        ],
      );
      const updated = await client.query(
        `UPDATE workflow_runs
         SET total_tokens = total_tokens + $2,
             total_cost = total_cost + $3,
             updated_at = now()
         WHERE id = $1`,
        [input.runId, input.usage.total, input.usage.computedCost],
      );
      if (updated.rowCount !== 1) throw new Error("calling run disappeared");
      await client.query("COMMIT");
      return inserted.rows[0].id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw new RuntimeAdapterError(
        "runtime_persistence_failed",
        "OpenClaw completed but usage attribution could not be persisted",
        { errorName: error instanceof Error ? error.name : "unknown" },
      );
    } finally {
      client.release();
    }
  }

  private async persistSystemError(input: {
    runId: string;
    agentId: string;
    ticketId: string | null;
    ref: string;
    attempts: number;
    error: RuntimeAdapterError;
  }): Promise<void> {
    try {
      await insertMessage(this.pool, {
        runId: input.runId,
        ticketId: input.ticketId,
        sender: "runtime:openclaw",
        recipient: "workflow-engine",
        type: "system",
        payload: {
          code: input.error.code,
          message: input.error.message,
          agentId: input.agentId,
          openclawRef: input.ref,
          attempts: input.attempts,
          failedAt: new Date().toISOString(),
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
    const environment: NodeJS.ProcessEnv = {
      ...safeBaseEnvironment(),
      ...Object.fromEntries(
        Object.entries(this.providerEnvironment).filter((entry): entry is [string, string] =>
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
