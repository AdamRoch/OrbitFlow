export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type PredicateOperator = "always" | "equals" | "notEquals" | "in" | "exists";

export interface EdgePredicate {
  operator: PredicateOperator;
  path?: string[];
  value?: JsonValue;
}

export interface WorkflowNode {
  id: string;
  agentId: string;
  config: JsonObject & {
    entry?: boolean;
    fanOut?: { maxConcurrency: number };
  };
}

export interface WorkflowEdge {
  source: string;
  target: string;
  condition: EdgePredicate;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  entryNodeId: string;
}

export type GraphEvaluation =
  | { kind: "dispatch"; node: WorkflowNode; edge: WorkflowEdge }
  | { kind: "complete" };

export class WorkflowGraphError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowGraphError";
  }
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

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkflowGraphError(`${field} must be a non-blank string`);
  }
  return value.trim();
}

function positiveId(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  throw new WorkflowGraphError(`${field} must be a positive integer`);
}

function parseCondition(value: unknown, edgeIndex: number): EdgePredicate {
  if (!isObject(value)) {
    throw new WorkflowGraphError(`edge ${edgeIndex} condition must be an object`);
  }
  const operator = value.operator;
  if (!(["always", "equals", "notEquals", "in", "exists"] as unknown[]).includes(operator)) {
    throw new WorkflowGraphError(`edge ${edgeIndex} condition has an unsupported operator`);
  }
  if (operator === "always") return { operator };

  if (
    !Array.isArray(value.path) ||
    value.path.length === 0 ||
    !value.path.every((part) => typeof part === "string" && part.trim() !== "")
  ) {
    throw new WorkflowGraphError(
      `edge ${edgeIndex} condition path must be a non-empty string array`,
    );
  }
  const path = value.path.map((part) => String(part));
  if (operator === "exists") {
    if (typeof value.value !== "boolean") {
      throw new WorkflowGraphError(`edge ${edgeIndex} exists condition requires a boolean value`);
    }
    return { operator, path, value: value.value } as EdgePredicate;
  }
  if (!("value" in value) || !isJsonValue(value.value)) {
    throw new WorkflowGraphError(`edge ${edgeIndex} condition requires a JSON value`);
  }
  if (operator === "in" && !Array.isArray(value.value)) {
    throw new WorkflowGraphError(`edge ${edgeIndex} in condition value must be an array`);
  }
  return { operator, path, value: value.value } as EdgePredicate;
}

/**
 * Parse the engine-owned graph contract without mutating the control-plane JSON.
 * Edge array order is the explicit transition priority: the first matching edge
 * wins. Cycles are accepted because one message advances exactly one activation.
 */
export function parseWorkflowGraph(value: unknown): WorkflowGraph {
  if (!isObject(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new WorkflowGraphError("workflow graph must contain nodes and edges arrays");
  }

  const ids = new Set<string>();
  const nodes = value.nodes.map((rawNode, index): WorkflowNode => {
    if (!isObject(rawNode) || !isObject(rawNode.config) || !isJsonValue(rawNode.config)) {
      throw new WorkflowGraphError(`node ${index} must contain a JSON object config`);
    }
    const id = nonBlank(rawNode.id, `node ${index} id`);
    if (ids.has(id)) throw new WorkflowGraphError(`duplicate node id: ${id}`);
    ids.add(id);

    const config = rawNode.config as WorkflowNode["config"];
    if (config.entry !== undefined && typeof config.entry !== "boolean") {
      throw new WorkflowGraphError(`node ${id} config.entry must be a boolean`);
    }
    if (config.fanOut !== undefined) {
      if (
        !isObject(config.fanOut) ||
        !Number.isSafeInteger(config.fanOut.maxConcurrency) ||
        Number(config.fanOut.maxConcurrency) <= 0
      ) {
        throw new WorkflowGraphError(
          `node ${id} config.fanOut.maxConcurrency must be a positive integer`,
        );
      }
    }
    return {
      id,
      agentId: positiveId(rawNode.agentId, `node ${id} agentId`),
      config,
    };
  });

  const entryNodes = nodes.filter((node) => node.config.entry === true);
  if (entryNodes.length !== 1) {
    throw new WorkflowGraphError("workflow graph must have exactly one entry node");
  }

  const edges = value.edges.map((rawEdge, index): WorkflowEdge => {
    if (!isObject(rawEdge)) throw new WorkflowGraphError(`edge ${index} must be an object`);
    const source = nonBlank(rawEdge.source, `edge ${index} source`);
    const target = nonBlank(rawEdge.target, `edge ${index} target`);
    if (!ids.has(source) || !ids.has(target)) {
      throw new WorkflowGraphError(`edge ${index} must reference existing nodes`);
    }
    return { source, target, condition: parseCondition(rawEdge.condition, index) };
  });

  return { nodes, edges, entryNodeId: entryNodes[0].id };
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function sameJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left === undefined ? null : canonical(left)) ===
    JSON.stringify(right === undefined ? null : canonical(right));
}

function readPath(output: JsonObject, path: string[]): { found: boolean; value?: JsonValue } {
  let current: JsonValue = output;
  for (const part of path) {
    if (current === null || Array.isArray(current) || typeof current !== "object") {
      return { found: false };
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) return { found: false };
    current = current[part];
  }
  return { found: true, value: current };
}

export function predicateMatches(predicate: EdgePredicate, output: JsonObject): boolean {
  if (predicate.operator === "always") return true;
  const resolved = readPath(output, predicate.path!);
  if (predicate.operator === "exists") return resolved.found === predicate.value;
  if (!resolved.found) return false;
  if (predicate.operator === "equals") return sameJson(resolved.value, predicate.value);
  if (predicate.operator === "notEquals") return !sameJson(resolved.value, predicate.value);
  return (predicate.value as JsonValue[]).some((candidate) =>
    sameJson(resolved.value, candidate),
  );
}

export function evaluateGraph(
  graph: WorkflowGraph,
  currentNodeId: string,
  output: JsonObject,
): GraphEvaluation {
  const outgoing = graph.edges.filter((edge) => edge.source === currentNodeId);
  if (outgoing.length === 0) return { kind: "complete" };
  const edge = outgoing.find((candidate) => predicateMatches(candidate.condition, output));
  if (!edge) {
    throw new WorkflowGraphError(`node ${currentNodeId} output matched no transition`);
  }
  const node = graph.nodes.find((candidate) => candidate.id === edge.target);
  if (!node) throw new WorkflowGraphError(`transition target disappeared: ${edge.target}`);
  return { kind: "dispatch", node, edge };
}

export function asJsonObject(value: unknown, field: string): JsonObject {
  if (!isObject(value) || !isJsonValue(value)) {
    throw new WorkflowGraphError(`${field} must be a JSON object`);
  }
  return value as JsonObject;
}
