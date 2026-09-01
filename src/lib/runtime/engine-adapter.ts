import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { insertMessage, type JsonObject } from "../postgres/message-bus.ts";
import {
  type RuntimeAdapter,
  type RuntimeDispatchRequest,
  type RuntimeReconciliationResult,
  type RuntimeStartResult,
} from "../postgres/workflow-engine.ts";
import {
  OpenClawRuntimeAdapter,
  RuntimeAdapterError,
  type RuntimeOutput,
  type WakeAgentInput,
} from "./openclaw.ts";

export interface OpenClawEngineAdapterOptions {
  pool: Pool;
  openclaw: OpenClawRuntimeAdapter;
  workspaceTools?: (agentId: string, nodeId: string, ticketId: string | null, runId: string) => string | null;
}

interface WorkerQuestionEvent {
  question: string;
  event: JsonObject;
}

interface DispatchToolContext extends JsonObject {
  version: 1;
  agentId: string;
  runId: string;
  ticketId: string | null;
  nodeId: string;
  invocationId: string;
  dispatchId: string;
  dispatchGeneration: string;
  dispatchSessionId: string;
}

interface CanonicalWakeInput extends WakeAgentInput {
  agentModel: string;
  dispatchGeneration: string;
  dispatchSessionId: string;
  toolContext: DispatchToolContext;
}

function providerEffectUncertain(error: RuntimeAdapterError): boolean {
  if (error.code === "openclaw_invocation_indeterminate") return true;
  const diagnostics = error.safeDetails.diagnostics;
  return typeof diagnostics === "object"
    && diagnostics !== null
    && !Array.isArray(diagnostics)
    && (diagnostics as Record<string, unknown>).metaReplayInvalid === true;
}

function workerQuestionEvent(output: RuntimeOutput): WorkerQuestionEvent | null {
  const questions = output.events.filter((event) => event.type === "question");
  if (questions.length === 0) return null;
  if (questions.length !== 1 || output.events.length !== 1) {
    throw new RuntimeAdapterError(
      "openclaw_malformed_output",
      "A question output must contain exactly one question event",
    );
  }
  if (Object.keys(output.artifact).length !== 0) {
    throw new RuntimeAdapterError(
      "openclaw_malformed_output",
      "A question output must contain an empty artifact",
    );
  }
  const event = questions[0]!;
  if (Object.keys(event).sort().join(",") !== "question,type") {
    throw new RuntimeAdapterError(
      "openclaw_malformed_output",
      "A question event must contain exactly type and question",
    );
  }
  if (typeof event.question !== "string" || event.question.trim() === "") {
    throw new RuntimeAdapterError(
      "openclaw_malformed_output",
      "A question event must contain a non-blank question",
    );
  }
  const question = event.question.trim();
  if (question.length > 12_000) {
    throw new RuntimeAdapterError(
      "openclaw_malformed_output",
      "A question event exceeds 12000 characters",
    );
  }
  return { question, event };
}

function durableRuntimeMessage(
  request: RuntimeDispatchRequest,
  output: RuntimeOutput,
  sessionId: string,
): { type: "answer" | "question" | "output"; payload: JsonObject; handoffBrief: string } {
  const questionContext = request.input.questionContext as Record<string, unknown> | undefined;
  const questionId = typeof questionContext?.questionId === "string"
    ? questionContext.questionId
    : null;
  const workerQuestion = workerQuestionEvent(output);
  if (questionId !== null && workerQuestion) {
    throw new RuntimeAdapterError(
      "openclaw_malformed_output",
      "An answer output cannot contain a question event",
    );
  }

  if (questionId !== null) {
    return {
      type: "answer",
      payload: {
        questionId,
        answer: output.handoff_brief,
        answeringDispatchId: request.dispatchId,
        dispatchGeneration: request.generation,
        sessionId,
      },
      handoffBrief: output.handoff_brief,
    };
  }
  if (workerQuestion) {
    return {
      type: "question",
      payload: {
        question: workerQuestion.question,
        runtimeEvent: workerQuestion.event,
        dispatchId: request.dispatchId,
        dispatchGeneration: request.generation,
        sessionId,
      },
      handoffBrief: workerQuestion.question,
    };
  }
  return {
    type: "output",
    payload: {
      dispatchId: request.dispatchId,
      dispatchGeneration: request.generation,
      sessionId,
      output: {
        artifact: output.artifact,
        handoff_brief: output.handoff_brief,
        events: output.events,
      },
    },
    handoffBrief: output.handoff_brief,
  };
}

/**
 * Bridges the engine's RuntimeAdapter interface to OpenClawRuntimeAdapter.
 *
 * Pinned OpenClaw 2026.4.15 uses `agent:<ref>:main` as its canonical session
 * key for every wake. Concurrent fan-out dispatches targeting the same agent
 * ref are serialized by OpenClawRuntimeAdapter's FACT-30 advisory lock.
 */
export class OpenClawEngineAdapter implements RuntimeAdapter {
  private readonly pool: Pool;
  private readonly openclaw: OpenClawRuntimeAdapter;
  private readonly workspaceTools: (agentId: string, nodeId: string, ticketId: string | null, runId: string) => string | null;

  constructor(options: OpenClawEngineAdapterOptions) {
    this.pool = options.pool;
    this.openclaw = options.openclaw;
    this.workspaceTools = options.workspaceTools ?? (() => null);
  }

  async startSession(request: RuntimeDispatchRequest): Promise<RuntimeStartResult> {
    try {
      const wakeInput = await this.canonicalWakeInput(request);
      const result = await this.openclaw.wakeAgent(wakeInput);
      const message = durableRuntimeMessage(request, result.output, wakeInput.dispatchSessionId);

      await insertMessage(this.pool, {
        runId: request.runId,
        ticketId: request.ticketId,
        sender: `agent:${request.agentId}`,
        recipient: "workflow-engine",
        type: message.type,
        payload: message.payload,
        handoffBrief: message.handoffBrief,
        tokenUsage: null,
      });

      return { kind: "started", sessionId: wakeInput.dispatchSessionId };
    } catch (error) {
      if (error instanceof RuntimeAdapterError) {
        if (error.code === "openclaw_invocation_indeterminate") {
          throw error;
        }
        return {
          kind: "confirmed_failure",
          reason: bounded(error.message),
          retrySafe: !providerEffectUncertain(error),
        };
      }
      if (error instanceof Error && error.name === "WorkflowStateError") {
        return { kind: "confirmed_failure", reason: bounded(error.message) };
      }
      throw error;
    }
  }

  async reconcileSession(
    request: RuntimeDispatchRequest,
  ): Promise<RuntimeReconciliationResult> {
    try {
      const wakeInput = await this.canonicalWakeInput(request);
      const result = await this.openclaw.wakeAgent(wakeInput);

      if (result.replayed) {
        const message = durableRuntimeMessage(request, result.output, wakeInput.dispatchSessionId);

        await insertMessage(this.pool, {
          runId: request.runId,
          ticketId: request.ticketId,
          sender: `agent:${request.agentId}`,
          recipient: "workflow-engine",
          type: message.type,
          payload: message.payload,
          handoffBrief: message.handoffBrief,
          tokenUsage: null,
        });

        return { kind: "started", sessionId: wakeInput.dispatchSessionId };
      }

      return { kind: "pending", reason: "unexpected new invocation during reconciliation" };
    } catch (error) {
      if (error instanceof RuntimeAdapterError) {
        if (error.code === "openclaw_invocation_indeterminate") {
          return {
            kind: "confirmed_failure",
            reason: bounded(
              `${error.code}: external effect is uncertain; the provider will not be called again. ${error.message}`,
            ),
            retrySafe: false,
          };
        }
        if (error.code === "openclaw_invocation_conflict") {
          return { kind: "confirmed_failure", reason: bounded(error.message) };
        }
        if (error.code === "openclaw_malformed_output") {
          return { kind: "confirmed_failure", reason: bounded(error.message) };
        }
        return { kind: "pending", reason: bounded(error.message) };
      }
      return { kind: "pending", reason: "unknown reconciliation error" };
    }
  }

  private async canonicalWakeInput(request: RuntimeDispatchRequest): Promise<CanonicalWakeInput> {
    const existing = await this.pool.query<{ wake_input: unknown; runtime_generation: string }>(
      `SELECT wake_input, runtime_generation::text
       FROM openclaw_dispatch_inputs WHERE dispatch_id = $1`,
      [request.dispatchId],
    );
    if (existing.rows[0]) {
      return parseCanonicalWakeInput(existing.rows[0], request);
    }

    const upstream = request.input.upstream as Record<string, unknown> | undefined;
    const handoffBrief = typeof upstream?.handoffBrief === "string"
      ? upstream.handoffBrief
      : null;
    const agent = await this.pool.query<{ system_prompt: string }>(
      "SELECT system_prompt FROM agents WHERE id = $1",
      [request.agentId],
    );
    const nodeSystemPrompt = agent.rows[0]?.system_prompt
      ?? `Execute node ${request.nodeId} in the Software Factory pipeline.`;
    const dispatchSessionId = deterministicSessionId(request.idempotencyKey);
    const toolContext: DispatchToolContext = {
      version: 1,
      agentId: request.agentId,
      runId: request.runId,
      ticketId: request.ticketId,
      nodeId: request.nodeId,
      invocationId: request.idempotencyKey,
      dispatchId: request.dispatchId,
      dispatchGeneration: request.generation,
      dispatchSessionId,
    };
    const candidate: CanonicalWakeInput = {
      runId: request.runId,
      agentId: request.agentId,
      invocationId: request.idempotencyKey,
      nodeId: request.nodeId,
      nodeSystemPrompt,
      agentModel: request.model,
      dispatchGeneration: request.generation,
      dispatchSessionId,
      ticketIds: request.ticketId ? [request.ticketId] : undefined,
      upstreamHandoffBrief: handoffBrief,
      workspaceTools: this.workspaceTools(request.agentId, request.nodeId, request.ticketId, request.runId),
      toolContext,
    };
    const inserted = await this.pool.query<{ wake_input: unknown; runtime_generation: string }>(
      `INSERT INTO openclaw_dispatch_inputs (dispatch_id, runtime_generation, wake_input)
       SELECT $1, $2, $3::jsonb
       FROM workflow_dispatches
       WHERE id = $1 AND run_id = $4 AND agent_id = $5 AND runtime_generation = $2
       ON CONFLICT (dispatch_id) DO NOTHING
       RETURNING wake_input, runtime_generation::text`,
      [
        request.dispatchId,
        request.generation,
        JSON.stringify(candidate),
        request.runId,
        request.agentId,
      ],
    );
    if (inserted.rows[0]) return parseCanonicalWakeInput(inserted.rows[0], request);
    const raced = await this.pool.query<{ wake_input: unknown; runtime_generation: string }>(
      `SELECT wake_input, runtime_generation::text
       FROM openclaw_dispatch_inputs WHERE dispatch_id = $1`,
      [request.dispatchId],
    );
    if (!raced.rows[0]) {
      throw new RuntimeAdapterError(
        "openclaw_invocation_conflict",
        "Dispatch changed before its canonical OpenClaw wake input was persisted",
      );
    }
    return parseCanonicalWakeInput(raced.rows[0], request);
  }
}

function parseCanonicalWakeInput(
  row: { wake_input: unknown; runtime_generation: string },
  request: RuntimeDispatchRequest,
): CanonicalWakeInput {
  const value = row.wake_input;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeAdapterError("runtime_persistence_failed", "Canonical OpenClaw wake input is invalid");
  }
  const candidate = value as Record<string, unknown>;
  const sessionId = deterministicSessionId(request.idempotencyKey);
  const ticketIds = request.ticketId ? [request.ticketId] : undefined;
  const expected = {
    runId: request.runId,
    agentId: request.agentId,
    invocationId: request.idempotencyKey,
    nodeId: request.nodeId,
    agentModel: request.model,
    dispatchGeneration: request.generation,
    dispatchSessionId: sessionId,
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (candidate[field] !== expectedValue) {
      throw new RuntimeAdapterError(
        "openclaw_invocation_conflict",
        `Canonical OpenClaw wake input does not match dispatch ${field}`,
      );
    }
  }
  if (row.runtime_generation !== request.generation) {
    throw new RuntimeAdapterError(
      "openclaw_invocation_conflict",
      "Canonical OpenClaw wake input does not match dispatch generation",
    );
  }
  if (typeof candidate.nodeSystemPrompt !== "string" || candidate.nodeSystemPrompt.trim() === "") {
    throw new RuntimeAdapterError("runtime_persistence_failed", "Canonical OpenClaw system prompt is invalid");
  }
  if (candidate.upstreamHandoffBrief !== null && typeof candidate.upstreamHandoffBrief !== "string") {
    throw new RuntimeAdapterError("runtime_persistence_failed", "Canonical OpenClaw handoff is invalid");
  }
  if (candidate.workspaceTools !== null && typeof candidate.workspaceTools !== "string") {
    throw new RuntimeAdapterError("runtime_persistence_failed", "Canonical OpenClaw tools are invalid");
  }
  if (JSON.stringify(candidate.ticketIds) !== JSON.stringify(ticketIds)) {
    throw new RuntimeAdapterError("openclaw_invocation_conflict", "Canonical OpenClaw tickets changed");
  }
  const context = candidate.toolContext as Record<string, unknown> | undefined;
  if (
    !context ||
    context.version !== 1 ||
    context.agentId !== request.agentId ||
    context.runId !== request.runId ||
    context.ticketId !== request.ticketId ||
    context.nodeId !== request.nodeId ||
    context.invocationId !== request.idempotencyKey ||
    context.dispatchId !== request.dispatchId ||
    context.dispatchGeneration !== request.generation ||
    context.dispatchSessionId !== sessionId
  ) {
    throw new RuntimeAdapterError("openclaw_invocation_conflict", "Canonical OpenClaw tool context changed");
  }
  return candidate as unknown as CanonicalWakeInput;
}

function deterministicSessionId(idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`orbitflow-engine-session:${idempotencyKey}`)
    .digest("hex")
    .slice(0, 16);
  return `orbitflow-session-${digest}`;
}

function bounded(message: string): string {
  return message.trim().slice(0, 500) || "unknown error";
}
