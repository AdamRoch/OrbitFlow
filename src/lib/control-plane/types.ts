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

export type UpdateResult<T> =
  | { kind: "updated"; value: T }
  | { kind: "not_found" }
  | { kind: "conflict" };
