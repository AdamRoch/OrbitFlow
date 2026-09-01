import type {
  JsonObject as MessageJsonObject,
} from "./postgres/message-bus.ts";
import type { JsonObject, JsonValue } from "./workflow/graph.ts";

export type ChannelIntakeDecision =
  | { kind: "needs_clarification"; question: string }
  | { kind: "ready"; spec: ChannelRunSpecInput };

export type FactoryOutputMode = "downloadable" | "web_service" | "railway_app";

export interface ChannelRunSpecInput {
  objective: string;
  acceptanceCriteria: string[];
  constraints: string[];
  factory?: { outputMode: FactoryOutputMode };
}

function object(value: unknown, field: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-blank string`);
  }
  return value.trim();
}

function stringList(value: unknown, field: string, required: boolean): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new TypeError(`${field} must be ${required ? "a non-empty" : "an"} array`);
  }
  return value.map((item, index) => nonBlank(item, `${field}[${index}]`));
}

function outputMode(value: unknown): FactoryOutputMode {
  if (value === "downloadable" || value === "web_service" || value === "railway_app") {
    return value;
  }
  throw new TypeError(
    "channel intake spec.factory.outputMode must be downloadable, web_service, or railway_app",
  );
}

function optionalFactorySpec(value: unknown): ChannelRunSpecInput["factory"] {
  if (value === undefined) return undefined;
  const factory = object(value, "channel intake spec.factory");
  if (Object.keys(factory).length !== 1 || !("outputMode" in factory)) {
    throw new TypeError("channel intake spec.factory must contain only outputMode");
  }
  return { outputMode: outputMode(factory.outputMode) };
}

export function parseChannelIntakeDecision(output: JsonObject): ChannelIntakeDecision {
  const artifact = object(output.artifact, "channel intake artifact");
  const intake = object(artifact.intake, "channel intake artifact.intake");
  const status = intake.status;
  if (status === "needs_clarification") {
    return {
      kind: "needs_clarification",
      question: nonBlank(intake.question, "channel intake question"),
    };
  }
  if (status !== "ready") {
    throw new TypeError("channel intake status must be needs_clarification or ready");
  }
  const spec = object(intake.spec, "channel intake spec");
  const factory = optionalFactorySpec(spec.factory);
  return {
    kind: "ready",
    spec: {
      objective: nonBlank(spec.objective, "channel intake spec.objective"),
      acceptanceCriteria: stringList(
        spec.acceptanceCriteria,
        "channel intake spec.acceptanceCriteria",
        true,
      ),
      constraints: stringList(spec.constraints, "channel intake spec.constraints", false),
      ...(factory ? { factory } : {}),
    },
  };
}

export function collectingChannelSpec(input: {
  provider: string;
  chat: MessageJsonObject;
  from?: MessageJsonObject;
  messageId: string;
  updateId: string;
  text: string;
}): MessageJsonObject {
  return {
    schemaVersion: 1,
    intake: { status: "collecting" },
    channelContext: {
      provider: input.provider,
      chat: input.chat,
      ...(input.from ? { requestedBy: input.from } : {}),
      inboundMessages: [{
        messageId: input.messageId,
        updateId: input.updateId,
        text: input.text,
      }],
    },
  };
}
