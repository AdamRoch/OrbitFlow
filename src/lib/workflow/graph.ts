import {
  parseWorkflowGraph,
  workflowEntryNodeId,
  WorkflowGraphError,
  type EdgePredicate,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type PredicateOperator,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from "./graph-contract.ts";

export {
  parseWorkflowGraph,
  workflowEntryNodeId,
  WorkflowGraphError,
  type EdgePredicate,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type PredicateOperator,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
};

export type GraphEvaluation =
  | { kind: "dispatch"; node: WorkflowNode; edge: WorkflowEdge }
  | { kind: "complete" };

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

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key]!)]),
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
    current = current[part]!;
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
