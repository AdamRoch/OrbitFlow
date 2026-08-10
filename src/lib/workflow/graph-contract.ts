import { ValidationError } from "@/lib/validate";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue | undefined };

export type PredicateOperator = "always" | "equals" | "notEquals" | "in" | "exists";

export interface EdgePredicate extends JsonObject {
  operator: PredicateOperator;
  path?: string[];
  value?: JsonValue;
}

export interface WorkflowNode extends JsonObject {
  id: string;
  agentId: string | number;
  config: JsonObject & {
    entry?: boolean;
    fanOut?: JsonObject & { maxConcurrency: number };
  };
}

export interface WorkflowEdge extends JsonObject {
  source: string;
  target: string;
  condition: EdgePredicate;
}

export interface WorkflowGraph extends JsonObject {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

function invalidGraph(message: string): never {
  throw new ValidationError(message, "invalid_graph");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    return invalidGraph(`${field} must be a non-blank string`);
  }
  return value.trim();
}

function validateAgentId(value: unknown, nodeId: string): void {
  const validNumber = typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const validString = typeof value === "string" && /^[1-9]\d*$/.test(value);
  if (!validNumber && !validString) {
    invalidGraph(`node ${nodeId} agentId must be a positive integer`);
  }
}

function validateCondition(value: unknown, edgeIndex: number): asserts value is EdgePredicate {
  if (!isObject(value)) invalidGraph(`edge ${edgeIndex} condition must be an object`);
  const operator = value.operator;
  if (!(operator === "always" || operator === "equals" || operator === "notEquals" || operator === "in" || operator === "exists")) {
    invalidGraph(`edge ${edgeIndex} condition has an unsupported operator`);
  }
  if (operator === "always") return;
  if (
    !Array.isArray(value.path) ||
    value.path.length === 0 ||
    !value.path.every((part) => typeof part === "string" && part.trim() !== "")
  ) {
    invalidGraph(`edge ${edgeIndex} condition path must be a non-empty string array`);
  }
  if (operator === "exists") {
    if (typeof value.value !== "boolean") {
      invalidGraph(`edge ${edgeIndex} exists condition requires a boolean value`);
    }
    return;
  }
  if (!("value" in value) || !isJsonValue(value.value)) {
    invalidGraph(`edge ${edgeIndex} condition requires a JSON value`);
  }
  if (operator === "in" && !Array.isArray(value.value)) {
    invalidGraph(`edge ${edgeIndex} in condition value must be an array`);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function canonicalWorkflowGraphJson(graph: WorkflowGraph): string {
  return JSON.stringify(canonical(graph));
}

export function validateWorkflowGraph(value: unknown): asserts value is WorkflowGraph {
  if (!isObject(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    invalidGraph("workflow graph must contain nodes and edges arrays");
  }
  if (!isJsonValue(value)) invalidGraph("workflow graph must contain only JSON values");

  const nodeIds = new Set<string>();
  let entryCount = 0;
  value.nodes.forEach((node, index) => {
    if (!isObject(node) || !isObject(node.config)) {
      invalidGraph(`node ${index} must contain a JSON object config`);
    }
    const id = requiredString(node.id, `node ${index} id`);
    if (nodeIds.has(id)) invalidGraph(`duplicate node id: ${id}`);
    nodeIds.add(id);
    validateAgentId(node.agentId, id);
    if (node.config.entry !== undefined && typeof node.config.entry !== "boolean") {
      invalidGraph(`node ${id} config.entry must be a boolean`);
    }
    if (node.config.entry === true) entryCount += 1;
    if (node.config.fanOut !== undefined) {
      if (
        !isObject(node.config.fanOut) ||
        !Number.isSafeInteger(node.config.fanOut.maxConcurrency) ||
        Number(node.config.fanOut.maxConcurrency) <= 0
      ) {
        invalidGraph(`node ${id} config.fanOut.maxConcurrency must be a positive integer`);
      }
    }
  });

  if (entryCount !== 1) invalidGraph("workflow graph must have exactly one entry node");

  const edgeIdentities = new Set<string>();
  value.edges.forEach((edge, index) => {
    if (!isObject(edge)) invalidGraph(`edge ${index} must be an object`);
    const source = requiredString(edge.source, `edge ${index} source`);
    const target = requiredString(edge.target, `edge ${index} target`);
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      invalidGraph(`edge ${index} must reference existing nodes`);
    }
    validateCondition(edge.condition, index);
    const identity = JSON.stringify([source, target, canonical(edge.condition)]);
    if (edgeIdentities.has(identity)) {
      invalidGraph(`duplicate transition from ${source} to ${target}`);
    }
    edgeIdentities.add(identity);
  });
}
