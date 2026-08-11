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
  type WakeAgentInput,
} from "./openclaw.ts";

export interface OpenClawEngineAdapterOptions {
  pool: Pool;
  openclaw: OpenClawRuntimeAdapter;
  workspaceTools?: (agentId: string, nodeId: string, ticketId: string | null, runId: string) => string | null;
}

/**
 * Bridges the engine's RuntimeAdapter interface to OpenClawRuntimeAdapter.
 *
 * Pinned OpenClaw 2026.4.15 uses `agent:<ref>:main` as its canonical session
 * key for every wake.  Concurrent fan-out dispatches targeting the same agent
 * ref are not serialised here.  Blocked by OEMR-86.
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
    const sessionId = deterministicSessionId(request.idempotencyKey);

    try {
      const upstream = request.input.upstream as Record<string, unknown> | undefined;
      const handoffBrief = upstream?.handoffBrief as string | undefined | null;

      const agent = await this.pool.query<{ system_prompt: string }>(
        "SELECT system_prompt FROM agents WHERE id = $1",
        [request.agentId],
      );
      const nodeSystemPrompt = agent.rows[0]?.system_prompt
        ?? `Execute node ${request.nodeId} in the Software Factory pipeline.`;

      const wakeInput: WakeAgentInput = {
        runId: request.runId,
        agentId: request.agentId,
        invocationId: request.idempotencyKey,
        nodeId: request.nodeId,
        nodeSystemPrompt,
        ticketIds: request.ticketId ? [request.ticketId] : undefined,
        upstreamHandoffBrief: handoffBrief ?? null,
        workspaceTools: this.workspaceTools(request.agentId, request.nodeId, request.ticketId, request.runId),
      };

      const result = await this.openclaw.wakeAgent(wakeInput);

      await insertMessage(this.pool, {
        runId: request.runId,
        ticketId: request.ticketId,
        sender: `agent:${request.agentId}`,
        recipient: "workflow-engine",
        type: "output",
        payload: {
          dispatchId: request.dispatchId,
          dispatchGeneration: request.generation,
          sessionId,
          output: {
            artifact: result.output.artifact,
            handoff_brief: result.output.handoff_brief,
            events: result.output.events,
          },
        } as JsonObject,
        handoffBrief: result.output.handoff_brief,
        tokenUsage: null,
      });

      return { kind: "started", sessionId };
    } catch (error) {
      if (error instanceof RuntimeAdapterError) {
        if (error.code === "openclaw_invocation_indeterminate") {
          throw error;
        }
        return { kind: "confirmed_failure", reason: bounded(error.message) };
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
      const result = await this.openclaw.wakeAgent({
        runId: request.runId,
        agentId: request.agentId,
        invocationId: request.idempotencyKey,
        nodeId: request.nodeId,
        nodeSystemPrompt: request.model,
        ticketIds: request.ticketId ? [request.ticketId] : undefined,
      });

      if (result.replayed) {
        const sessionId = deterministicSessionId(request.idempotencyKey);

        await insertMessage(this.pool, {
          runId: request.runId,
          ticketId: request.ticketId,
          sender: `agent:${request.agentId}`,
          recipient: "workflow-engine",
          type: "output",
          payload: {
            dispatchId: request.dispatchId,
            dispatchGeneration: request.generation,
            sessionId,
            output: {
              artifact: result.output.artifact,
              handoff_brief: result.output.handoff_brief,
              events: result.output.events,
            },
          } as JsonObject,
          handoffBrief: result.output.handoff_brief,
          tokenUsage: null,
        });

        return { kind: "started", sessionId };
      }

      return { kind: "pending", reason: "unexpected new invocation during reconciliation" };
    } catch (error) {
      if (error instanceof RuntimeAdapterError) {
        if (error.code === "openclaw_invocation_indeterminate") {
          return { kind: "absent" };
        }
        if (error.code === "openclaw_invocation_conflict") {
          return { kind: "absent" };
        }
        return { kind: "pending", reason: bounded(error.message) };
      }
      return { kind: "pending", reason: "unknown reconciliation error" };
    }
  }
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
