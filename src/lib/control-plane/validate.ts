import cron from "node-cron";
import { ValidationError } from "../api";
import type {
  CreateAgentInput,
  CreateSkillInput,
  CreateWorkflowInput,
  CreateAgentScheduleInput,
  JsonObject,
  UpdateAgentInput,
  UpdateSkillInput,
  UpdateWorkflowInput,
  UpdateScheduleInput,
} from "./types";
import { parseWorkflowGraph, WorkflowGraphError } from "@/lib/workflow/graph-contract";

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

function requiredTimestamp(value: unknown): string {
  if (value === undefined) {
    throw new ValidationError(
      "expectedUpdatedAt is required for PATCH requests",
      "missing_precondition",
    );
  }
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

function requiredCronExpression(value: unknown): string {
  const cronExpression = requiredString(value, "cronExpression");
  if (!cron.validate(cronExpression)) {
    throw new ValidationError("cronExpression must be a valid cron expression", "invalid_cron");
  }
  return cronExpression;
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
  const result: UpdateAgentInput = { expectedUpdatedAt: requiredTimestamp(input.expectedUpdatedAt) };
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

export function parseCreateAgentSchedule(body: Record<string, unknown>): CreateAgentScheduleInput {
  const input = requestObject(body);
  createFields(input, ["cronExpression", "taskPrompt", "enabled"]);
  return {
    cronExpression: requiredCronExpression(input.cronExpression),
    taskPrompt: requiredString(input.taskPrompt, "taskPrompt"),
    enabled: requiredBoolean(input.enabled, "enabled"),
  };
}

export function parseUpdateSchedule(body: Record<string, unknown>): UpdateScheduleInput {
  const input = requestObject(body);
  updateFields(input, ["cronExpression", "taskPrompt", "enabled"]);
  const result: UpdateScheduleInput = { expectedUpdatedAt: requiredTimestamp(input.expectedUpdatedAt) };
  if (input.cronExpression !== undefined) result.cronExpression = requiredCronExpression(input.cronExpression);
  if (input.taskPrompt !== undefined) result.taskPrompt = requiredString(input.taskPrompt, "taskPrompt");
  if (input.enabled !== undefined) result.enabled = requiredBoolean(input.enabled, "enabled");
  if (result.enabled === true && result.cronExpression === undefined) {
    throw new ValidationError(
      "cronExpression is required when enabling a schedule so it can be validated before persistence",
      "invalid_cron",
    );
  }
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
  const result: UpdateSkillInput = { expectedUpdatedAt: requiredTimestamp(input.expectedUpdatedAt) };
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
  try {
    return parseWorkflowGraph(graph);
  } catch (error) {
    if (error instanceof WorkflowGraphError) {
      throw new ValidationError(error.message, "invalid_graph");
    }
    throw error;
  }
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
  const result: UpdateWorkflowInput = { expectedUpdatedAt: requiredTimestamp(input.expectedUpdatedAt) };
  if (input.name !== undefined) result.name = requiredString(input.name, "name");
  if (input.description !== undefined) result.description = requiredString(input.description, "description");
  if (input.graph !== undefined) result.graph = parseGraph(input.graph);
  if (input.isTemplate !== undefined) result.isTemplate = requiredBoolean(input.isTemplate, "isTemplate");
  return result;
}
