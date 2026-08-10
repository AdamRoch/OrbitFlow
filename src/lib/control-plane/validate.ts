import { ValidationError } from "../validate";
import type {
  CreateAgentInput,
  CreateSkillInput,
  CreateWorkflowInput,
  JsonObject,
  UpdateAgentInput,
  UpdateSkillInput,
  UpdateWorkflowInput,
} from "./types";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new ValidationError("request body must be a JSON object", "invalid_type");
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string`, "invalid_type");
  }
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} must not be empty`, "empty");
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ValidationError(`${field} must be a boolean`, "invalid_type");
  }
  return value;
}

function requiredObject(value: unknown, field: string): JsonObject {
  if (!isObject(value)) {
    throw new ValidationError(`${field} must be a JSON object`, "invalid_type");
  }
  return value;
}

function nullableObject(value: unknown, field: string): JsonObject | null {
  if (value === null) return null;
  return requiredObject(value, field);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function optionalTimestamp(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(
      "expectedUpdatedAt must be an ISO-8601 timestamp",
      "invalid_timestamp",
    );
  }
  return value;
}

function updateFields<T extends object>(body: T, accepted: readonly string[]): void {
  const fields = Object.keys(body).filter((key) => key !== "expectedUpdatedAt");
  if (fields.length === 0) {
    throw new ValidationError("at least one field must be provided", "missing");
  }
  for (const field of fields) {
    if (!accepted.includes(field)) {
      throw new ValidationError(`unknown field: ${field}`, "unknown_field");
    }
  }
}

function createFields(body: Record<string, unknown>, accepted: readonly string[]): void {
  for (const field of Object.keys(body)) {
    if (!accepted.includes(field)) {
      throw new ValidationError(`unknown field: ${field}`, "unknown_field");
    }
  }
}

export function parseId(value: string, field = "id"): string {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ValidationError(`${field} must be a positive integer`, "invalid_id");
  }
  return value;
}

export function parseCreateAgent(body: Record<string, unknown>): CreateAgentInput {
  const input = requestObject(body);
  createFields(input, [
    "name", "role", "systemPrompt", "model", "codingToolEnabled", "guardrails",
    "interactionRules", "channelBinding", "memory", "openclawRef",
  ]);
  return {
    name: requiredString(input.name, "name"),
    role: requiredString(input.role, "role"),
    systemPrompt: requiredString(input.systemPrompt, "systemPrompt"),
    model: requiredString(input.model, "model"),
    codingToolEnabled: requiredBoolean(input.codingToolEnabled, "codingToolEnabled"),
    guardrails: requiredObject(input.guardrails, "guardrails"),
    interactionRules: requiredObject(input.interactionRules, "interactionRules"),
    channelBinding: nullableObject(input.channelBinding, "channelBinding"),
    memory: requiredObject(input.memory, "memory"),
    openclawRef: nullableString(input.openclawRef, "openclawRef"),
  };
}

export function parseUpdateAgent(body: Record<string, unknown>): UpdateAgentInput {
  const input = requestObject(body);
  updateFields(input, [
    "name", "role", "systemPrompt", "model", "codingToolEnabled", "guardrails",
    "interactionRules", "channelBinding", "memory", "openclawRef",
  ]);
  const result: UpdateAgentInput = { expectedUpdatedAt: optionalTimestamp(input.expectedUpdatedAt) };
  if (input.name !== undefined) result.name = requiredString(input.name, "name");
  if (input.role !== undefined) result.role = requiredString(input.role, "role");
  if (input.systemPrompt !== undefined) result.systemPrompt = requiredString(input.systemPrompt, "systemPrompt");
  if (input.model !== undefined) result.model = requiredString(input.model, "model");
  if (input.codingToolEnabled !== undefined) result.codingToolEnabled = requiredBoolean(input.codingToolEnabled, "codingToolEnabled");
  if (input.guardrails !== undefined) result.guardrails = requiredObject(input.guardrails, "guardrails");
  if (input.interactionRules !== undefined) result.interactionRules = requiredObject(input.interactionRules, "interactionRules");
  if (input.channelBinding !== undefined) result.channelBinding = nullableObject(input.channelBinding, "channelBinding");
  if (input.memory !== undefined) result.memory = requiredObject(input.memory, "memory");
  if (input.openclawRef !== undefined) result.openclawRef = nullableString(input.openclawRef, "openclawRef");
  return result;
}

export function parseCreateSkill(body: Record<string, unknown>): CreateSkillInput {
  const input = requestObject(body);
  createFields(input, ["name", "description", "procedure"]);
  return {
    name: requiredString(input.name, "name"),
    description: requiredString(input.description, "description"),
    procedure: requiredString(input.procedure, "procedure"),
  };
}

export function parseUpdateSkill(body: Record<string, unknown>): UpdateSkillInput {
  const input = requestObject(body);
  updateFields(input, ["name", "description", "procedure"]);
  const result: UpdateSkillInput = { expectedUpdatedAt: optionalTimestamp(input.expectedUpdatedAt) };
  if (input.name !== undefined) result.name = requiredString(input.name, "name");
  if (input.description !== undefined) result.description = requiredString(input.description, "description");
  if (input.procedure !== undefined) result.procedure = requiredString(input.procedure, "procedure");
  return result;
}

/**
 * Validate only graph structure. Values are returned by reference so routes and
 * repositories never add defaults, reorder fields, or invent engine behavior.
 */
export function parseGraph(value: unknown): JsonObject {
  const graph = requiredObject(value, "graph");
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new ValidationError("graph must contain nodes and edges arrays", "invalid_graph");
  }

  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!isObject(node)) {
      throw new ValidationError("graph.nodes must contain objects", "invalid_graph");
    }
    const id = requiredString(node.id, "graph node id");
    if (nodeIds.has(id)) {
      throw new ValidationError("graph node ids must be unique", "invalid_graph");
    }
    nodeIds.add(id);
    const agentId = node.agentId;
    if (
      !(
        (typeof agentId === "string" && /^[1-9]\d*$/.test(agentId)) ||
        (typeof agentId === "number" && Number.isSafeInteger(agentId) && agentId > 0)
      )
    ) {
      throw new ValidationError("graph node agentId must be a positive integer", "invalid_graph");
    }
    requiredObject(node.config, "graph node config");
  }

  for (const edge of graph.edges) {
    if (!isObject(edge)) {
      throw new ValidationError("graph.edges must contain objects", "invalid_graph");
    }
    const source = requiredString(edge.source, "graph edge source");
    const target = requiredString(edge.target, "graph edge target");
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      throw new ValidationError("graph edge must reference existing nodes", "invalid_graph");
    }
    if (!("condition" in edge)) {
      throw new ValidationError("graph edge condition is required", "invalid_graph");
    }
  }
  return graph;
}

export function parseCreateWorkflow(body: Record<string, unknown>): CreateWorkflowInput {
  const input = requestObject(body);
  createFields(input, ["name", "description", "graph", "isTemplate"]);
  return {
    name: requiredString(input.name, "name"),
    description: requiredString(input.description, "description"),
    graph: parseGraph(input.graph),
    isTemplate: requiredBoolean(input.isTemplate, "isTemplate"),
  };
}

export function parseUpdateWorkflow(body: Record<string, unknown>): UpdateWorkflowInput {
  const input = requestObject(body);
  updateFields(input, ["name", "description", "graph", "isTemplate"]);
  const result: UpdateWorkflowInput = { expectedUpdatedAt: optionalTimestamp(input.expectedUpdatedAt) };
  if (input.name !== undefined) result.name = requiredString(input.name, "name");
  if (input.description !== undefined) result.description = requiredString(input.description, "description");
  if (input.graph !== undefined) result.graph = parseGraph(input.graph);
  if (input.isTemplate !== undefined) result.isTemplate = requiredBoolean(input.isTemplate, "isTemplate");
  return result;
}
