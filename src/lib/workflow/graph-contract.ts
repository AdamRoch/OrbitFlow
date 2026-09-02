export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue | undefined };

export type PredicateOperator = "always" | "equals" | "notEquals" | "in" | "exists";
export type PlanMode = "off" | "allowed" | "required";
export type EscalationTarget = "agent" | "human-via-channel" | "human-via-UI";

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
    channelBinding?: boolean;
    fanOut?: JsonObject & { over: "openTickets"; maxConcurrency: number };
    planMode?: PlanMode;
    may_answer_questions?: boolean;
    questionEscalation?: JsonObject & {
      target: EscalationTarget;
      agentId?: string | number;
    };
    approvalGates?: JsonObject & {
      pauseBefore?: boolean;
      pauseAfter?: boolean;
    };
  };
}

export interface WorkflowEdge extends JsonObject {
  id?: string;
  source: string;
  target: string;
  condition: EdgePredicate;
}

export interface WorkflowGraph extends JsonObject {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export class WorkflowGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowGraphError";
  }
}

function invalidGraph(message: string): never {
  throw new WorkflowGraphError(message);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
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

function requiredCanonicalId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    return invalidGraph(`${field} must be a non-blank string`);
  }
  if (value !== value.trim() || value !== value.normalize("NFC")) {
    return invalidGraph(`${field} must already be in canonical form`);
  }
  return value;
}

function validateAgentId(value: unknown, field: string): void {
  const validNumber = typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const validString = typeof value === "string" && /^[1-9]\d*$/.test(value);
  if (!validNumber && !validString) {
    invalidGraph(`${field} must be a positive integer`);
  }
}

function validateKnownNodeConfig(config: Record<string, unknown>, nodeId: string): void {
  if (config.entry !== undefined && typeof config.entry !== "boolean") {
    invalidGraph(`node ${nodeId} config.entry must be a boolean`);
  }
  if (config.channelBinding !== undefined && typeof config.channelBinding !== "boolean") {
    invalidGraph(`node ${nodeId} config.channelBinding must be a boolean`);
  }
  if (config.fanOut !== undefined) {
    if (!isObject(config.fanOut)) {
      invalidGraph(`node ${nodeId} config.fanOut must be an object`);
    }
    if (config.fanOut.over !== undefined && config.fanOut.over !== "openTickets") {
      invalidGraph(`node ${nodeId} config.fanOut.over must be openTickets`);
    }
    if (!Number.isSafeInteger(config.fanOut.maxConcurrency) || Number(config.fanOut.maxConcurrency) <= 0) {
      invalidGraph(`node ${nodeId} config.fanOut.maxConcurrency must be a positive integer`);
    }
  }
  if (
    config.planMode !== undefined &&
    config.planMode !== "off" &&
    config.planMode !== "allowed" &&
    config.planMode !== "required"
  ) {
    invalidGraph(`node ${nodeId} config.planMode must be off, allowed, or required`);
  }
  if (config.may_answer_questions !== undefined && typeof config.may_answer_questions !== "boolean") {
    invalidGraph(`node ${nodeId} config.may_answer_questions must be a boolean`);
  }
  if (config.questionEscalation !== undefined) {
    if (!isObject(config.questionEscalation)) {
      invalidGraph(`node ${nodeId} config.questionEscalation must be an object`);
    }
    const target = config.questionEscalation.target;
    if (target !== "agent" && target !== "human-via-channel" && target !== "human-via-UI") {
      invalidGraph(`node ${nodeId} config.questionEscalation.target is unsupported`);
    }
    if (target === "agent" || config.questionEscalation.agentId !== undefined) {
      validateAgentId(
        config.questionEscalation.agentId,
        `node ${nodeId} config.questionEscalation.agentId`,
      );
    }
  }
  if (config.approvalGates !== undefined) {
    if (!isObject(config.approvalGates)) {
      invalidGraph(`node ${nodeId} config.approvalGates must be an object`);
    }
    if (
      config.approvalGates.pauseBefore !== undefined &&
      typeof config.approvalGates.pauseBefore !== "boolean"
    ) {
      invalidGraph(`node ${nodeId} config.approvalGates.pauseBefore must be a boolean`);
    }
    if (
      config.approvalGates.pauseAfter !== undefined &&
      typeof config.approvalGates.pauseAfter !== "boolean"
    ) {
      invalidGraph(`node ${nodeId} config.approvalGates.pauseAfter must be a boolean`);
    }
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

/** Deterministic JSON with sorted object keys, for hashes and equality checks. */
export function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function canonicalWorkflowGraphJson(graph: WorkflowGraph): string {
  return stableJson(graph);
}

export function parseWorkflowGraph(value: unknown): WorkflowGraph {
  validateWorkflowGraph(value);
  return value;
}

export function workflowEntryNodeId(graph: WorkflowGraph): string {
  return graph.nodes.find((node) => node.config.entry === true)!.id;
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
    const id = requiredCanonicalId(node.id, `node ${index} id`);
    if (nodeIds.has(id)) invalidGraph(`duplicate node id: ${id}`);
    nodeIds.add(id);
    validateAgentId(node.agentId, `node ${id} agentId`);
    validateKnownNodeConfig(node.config, id);
    if (node.config.entry === true) entryCount += 1;
  });

  if (entryCount !== 1) invalidGraph("workflow graph must have exactly one entry node");

  const edgeIdentities = new Set<string>();
  value.edges.forEach((edge, index) => {
    if (!isObject(edge)) invalidGraph(`edge ${index} must be an object`);
    if (edge.id !== undefined) requiredCanonicalId(edge.id, `edge ${index} id`);
    const source = requiredCanonicalId(edge.source, `edge ${index} source`);
    const target = requiredCanonicalId(edge.target, `edge ${index} target`);
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

export type GraphEvaluation =
  | { kind: "dispatch"; node: WorkflowNode; edge: WorkflowEdge }
  | { kind: "complete" };

function sameJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return stableJson(left ?? null) === stableJson(right ?? null);
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
