export type ModelOption = {
  id: string;
  name: string;
  contextLength: number;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
};
export type ModelCatalog = {
  models: ModelOption[];
  fetchedAt: string;
  stale: boolean;
};

export type Agent = {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  model: string;
  tools: string[];
  memory: string[];
  skills: { name: string; steps: string[] }[];
  approval: "always" | "publish" | "never";
  guardrails: {
    maxCostUsd: number;
    maxTurns: number;
    callsPerHour: number;
    blockedActions: string[];
  };
  schedule: {
    enabled: boolean;
    expression: string;
    prompt: string;
    workflowId: string | null;
  };
  telegram: boolean;
};
export type WorkflowNode = {
  id: string;
  agentId: string;
  label: string;
  x: number;
  y: number;
  terminalOutcomes: string[];
};
export type Workflow = {
  id: string;
  name: string;
  description: string;
  entryNode: string;
  requiresSource?: boolean;
  nodes: WorkflowNode[];
  edges: { id: string; from: string; to: string; outcome: string }[];
};
export type Message = {
  id: string;
  runId: string;
  from: string;
  to: string;
  content: string;
  kind: string;
  createdAt: string;
};
export type Run = {
  id: string;
  workflowId: string | null;
  agentId: string | null;
  prompt: string;
  status: string;
  currentNode: string | null;
  createdAt: string;
  updatedAt: string;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  usageIncomplete?: boolean;
  usageNote?: string;
  error: string | null;
  revisionId: string | null;
  parentRunId: string | null;
  steps: number;
};
export type Revision = {
  id: string;
  runId: string;
  createdAt: string;
  files: string[];
  approved: boolean;
};
export type Event = {
  id: string;
  runId: string | null;
  kind: string;
  content: string;
  createdAt: string;
};
export type RunDetail = {
  approvalKind?: "turn" | "release";
  approvalToken?: string;
  run: Run;
  messages: Message[];
  events: Event[];
  revisions: Revision[];
  executionSnapshot: { agents: Agent[]; workflow: Workflow | null };
};
export type ScheduleStatus = {
  agentId: string;
  enabled: boolean;
  expression: string;
  nextAt: string | null;
  error: string | null;
};
export type Settings = {
  unknownCostRuns?: number;
  runtime: string;
  runtimeVersion: string;
  providerConfigured: boolean;
  budgetUsd: number;
  spentUsd: number;
  telegramConfigured: boolean;
  telegramUsername: string | null;
  databaseReady: boolean;
};
