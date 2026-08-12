/** JSON object values accepted by the control-plane API. */
export type JsonObject = Record<string, unknown>;

export interface SkillDTO {
  id: string;
  name: string;
  description: string;
  procedure: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDTO {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  model: string;
  codingToolEnabled: boolean;
  guardrails: JsonObject;
  interactionRules: JsonObject;
  channelBinding: JsonObject | null;
  memory: JsonObject;
  openclawRef: string | null;
  skills: SkillDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDTO {
  id: string;
  name: string;
  description: string;
  graph: JsonObject;
  isTemplate: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleDTO {
  id: string;
  cronExpression: string;
  workflowId: string | null;
  agentId: string | null;
  taskPrompt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentInput {
  name: string;
  role: string;
  systemPrompt: string;
  model: string;
  codingToolEnabled: boolean;
  guardrails: JsonObject;
  interactionRules: JsonObject;
  channelBinding: JsonObject | null;
  memory: JsonObject;
  openclawRef: string | null;
}

export interface UpdateAgentInput extends Partial<CreateAgentInput> {
  /** Required optimistic-lock version read from the resource's updatedAt. */
  expectedUpdatedAt: string;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  procedure: string;
}

export interface UpdateSkillInput extends Partial<CreateSkillInput> {
  /** Required optimistic-lock version read from the resource's updatedAt. */
  expectedUpdatedAt: string;
}

export interface CreateWorkflowInput {
  name: string;
  description: string;
  graph: JsonObject;
  isTemplate: boolean;
}

export interface UpdateWorkflowInput extends Partial<CreateWorkflowInput> {
  /** Required optimistic-lock version read from the resource's updatedAt. */
  expectedUpdatedAt: string;
}

export interface CreateAgentScheduleInput {
  cronExpression: string;
  taskPrompt: string;
  enabled: boolean;
}

export interface UpdateScheduleInput extends Partial<CreateAgentScheduleInput> {
  /** Required optimistic-lock version read from the resource's updatedAt. */
  expectedUpdatedAt: string;
}

export type UpdateResult<T> =
  | { kind: "updated"; value: T }
  | { kind: "not_found" }
  | { kind: "conflict" };

/** Filters are part of the monitoring snapshot contract, not stream state. */
export interface MonitoringFilters {
  runId: string | null;
  agentId: string | null;
  messageType: string | null;
}

export interface MonitoringRunDTO {
  id: string;
  workflowName: string;
  status: string;
  triggerType: string;
  createdAt: string;
}

export interface MonitoringTicketDTO {
  id: string;
  runId: string | null;
  identifier: string;
  title: string;
  status: string;
  priority: number;
  assigneeAgentId: string | null;
  assigneeName: string | null;
  updatedAt: string;
  questionCount?: number;
  pendingQuestionCount?: number;
}

export interface MonitoringQuestionDTO {
  id: string;
  runId: string;
  ticketId: string | null;
  ticketIdentifier: string | null;
  kind: "question" | "approval";
  boundary: "worker" | "before" | "after";
  route: "agent" | "human-via-channel" | "human-via-UI";
  questionText: string;
  createdAt: string;
}

export interface MonitoringMessageDTO {
  id: string;
  runId: string;
  ticketId: string | null;
  sequenceNumber: string;
  sender: string;
  recipient: string;
  type: string;
  payload: JsonObject;
  handoffBrief: string | null;
  createdAt: string;
}

export type MonitoringAgentStatus = "idle" | "working" | "waiting-on-question";

export interface MonitoringAgentDTO {
  id: string;
  name: string;
  role: string;
  status: MonitoringAgentStatus;
  currentTask: { id: string; identifier: string; title: string; runId: string } | null;
  logs: MonitoringMessageDTO[];
  /** The current-task log is deliberately capped at three durable messages. */
  logsTruncated: boolean;
}

export interface MonitoringAgentOptionDTO {
  id: string;
  name: string;
}

export interface MonitoringRunCostDTO {
  runId: string;
  workflowName: string;
  tokensIn: string;
  tokensOut: string;
  totalTokens: string;
  totalCost: string;
}

export interface MonitoringAgentCostDTO extends MonitoringRunCostDTO {
  agentId: string;
  agentName: string;
  costLimit: string | null;
  overCostLimit: boolean;
}

/** Every collection is deliberately bounded. The SSE stream only wakes re-reads. */
export interface MonitoringSnapshot {
  filters: MonitoringFilters;
  /** Application timestamp after the repeatable-read transaction committed. */
  readAt: string;
  runs: MonitoringRunDTO[];
  board: MonitoringTicketDTO[];
  pendingQuestions?: MonitoringQuestionDTO[];
  trail: MonitoringMessageDTO[];
  /** Every capped collection reports whether an authoritative continuation exists. */
  runsTruncated: boolean;
  boardTruncated: boolean;
  trailTruncated: boolean;
  agents: MonitoringAgentDTO[];
  /** Unfiltered selected-run participants used to keep the Agent combobox usable. */
  agentOptions: MonitoringAgentOptionDTO[];
  runCosts: MonitoringRunCostDTO[];
  agentCosts: MonitoringAgentCostDTO[];
  agentsTruncated: boolean;
  runCostsTruncated: boolean;
  agentCostsTruncated: boolean;
  agentOptionsTruncated: boolean;
}
