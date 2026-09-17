import { readFileSync, writeSync } from "node:fs";
import {
  executeLocalTurn,
  parseModel,
  providerKeyName,
  RuntimeFailure,
  type ExecuteTurnInput,
  type RuntimeEvent,
  type RuntimeUsage,
} from "./runtime.js";

function frame(type: string, content: Record<string, unknown>) {
  writeSync(1, `${JSON.stringify({ type, ...content })}\n`);
}

function boundedEvent(event: RuntimeEvent): RuntimeEvent {
  const bounded = JSON.stringify(event, (_key, value) => {
    if (typeof value === "string" && value.length > 2_000)
      return `${value.slice(0, 2_000)}… [truncated]`;
    if (Array.isArray(value) && value.length > 40)
      return [...value.slice(0, 40), `[${value.length - 40} more items]`];
    return value;
  });
  return JSON.parse(bounded) as RuntimeEvent;
}

function redacted(message: string, agentModel?: string): string {
  if (!agentModel) return message.slice(0, 500);
  try {
    const name = providerKeyName(parseModel(agentModel).provider);
    const value = process.env[name];
    return (value ? message.replaceAll(value, "[redacted]") : message).slice(0, 500);
  } catch {
    return message.slice(0, 500);
  }
}

async function main() {
  const path = process.argv[2];
  if (path !== "/runtime/input.json")
    throw new Error("Trusted runtime runner requires /runtime/input.json");
  const input = JSON.parse(readFileSync(path, "utf8")) as ExecuteTurnInput;
  if (
    !input ||
    typeof input.id !== "string" ||
    typeof input.prompt !== "string" ||
    typeof input.agent?.model !== "string" ||
    !input.files ||
    typeof input.files !== "object" ||
    typeof input.maxCostUsd !== "number"
  )
    throw new Error("Trusted runtime runner received invalid input");

  // The sandbox runner owns Docker, but the model process in its inner container
  // runs as UID 1000 and receives no Docker socket or application credentials.
  process.env.ORBITFLOW_INNER_UID = "1000";
  try {
    const result = await executeLocalTurn({
      ...input,
      onEvent: (event) => frame("event", { event: boundedEvent(event) }),
    });
    frame("result", { result });
  } catch (error) {
    const usage: RuntimeUsage =
      error instanceof RuntimeFailure
        ? error.usage
        : { costUsd: null, inputTokens: 0, outputTokens: 0 };
    frame("failure", {
      message: redacted(
        error instanceof Error ? error.message : "Runtime runner failed",
        input.agent.model,
      ),
      usage,
    });
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  frame("failure", {
    message: redacted(error instanceof Error ? error.message : "Runtime runner failed"),
    usage: { costUsd: null, inputTokens: 0, outputTokens: 0 },
  });
  process.exitCode = 1;
});
