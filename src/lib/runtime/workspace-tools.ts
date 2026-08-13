export interface ProductionWorkspaceToolsOptions {
  agentTool?: string;
  codingTool?: string;
}

export function createProductionWorkspaceTools(
  options: ProductionWorkspaceToolsOptions = {},
): (agentId: string, nodeId: string, ticketId: string | null, runId: string) => string {
  const agentTool = options.agentTool ?? "/app/bin/orbit-agent-tools.mjs";
  const codingTool = options.codingTool ?? "/app/bin/orbit-coding-tool.mjs";

  return (agentId, nodeId, ticketId, runId) => [
    `# OrbitFlow tools for ${nodeId}`,
    "ORBITFLOW_PLATFORM_DATABASE_URL is already bound to the platform database.",
    "Never print, replace, export, or invent its value.",
    "Replace <unique-suffix> with a new short value for each command invocation.",
    "Use only the commands required by the node prompt.",
    "",
    "### list_projects",
    `DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" ${agentTool} list_projects '${JSON.stringify({
      agentId,
      runId,
      limit: 50,
      idempotencyKey: "projects-<unique-suffix>",
    })}'`,
    "Use a returned project id for create_ticket. Never invent a project id.",
    "",
    "### list_tickets",
    `DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" ${agentTool} list_tickets '${JSON.stringify({
      agentId,
      runId,
      limit: 50,
      idempotencyKey: "list-<unique-suffix>",
    })}'`,
    "",
    "### create_ticket",
    `DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" ${agentTool} create_ticket '${JSON.stringify({
      agentId,
      runId,
      projectId: "<projectId from list_projects>",
      title: "<title>",
      description: "<description or null>",
      acceptanceCriteria: "<acceptance criteria or null>",
      status: "todo",
      priority: 1,
      idempotencyKey: "create-<unique-suffix>",
    })}'`,
    ...(ticketId ? [
      "",
      "### update_ticket",
      `DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" ${agentTool} update_ticket '${JSON.stringify({
        agentId,
        runId,
        ticketId,
        expectedUpdatedAt: "<updatedAt from list_tickets>",
        status: "<backlog|todo|in_progress|done|canceled>",
        idempotencyKey: "update-<unique-suffix>",
      })}'`,
      "",
      "### post_message",
      `DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" ${agentTool} post_message '${JSON.stringify({
        agentId,
        runId,
        ticketId,
        recipient: "<recipient>",
        type: "<output|feedback|question|answer|system>",
        payload: {},
        handoffBrief: "<handoff brief or null>",
        idempotencyKey: "message-<unique-suffix>",
      })}'`,
    ] : []),
    "",
    "### start_run_workspace",
    `DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" ORBITFLOW_WORKSPACE_ROOT="$ORBITFLOW_WORKSPACE_ROOT" ${codingTool} start_run_workspace '${JSON.stringify({ runId })}'`,
    "Use the returned workspace path exactly in delegate_coding_task.",
    "",
    "### delegate_coding_task",
    "Replace <task> with a JSON-escaped and shell-quoted task description.",
    `DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" ORBITFLOW_RUN_ID=${runId} ORBITFLOW_AGENT_ID=${agentId} ORBITFLOW_WORKSPACE_ROOT="$ORBITFLOW_WORKSPACE_ROOT" ${codingTool} delegate_coding_task '${JSON.stringify({
      task: "<task>",
      workspace: "<workspace returned by start_run_workspace>",
    })}'`,
  ].join("\n");
}
