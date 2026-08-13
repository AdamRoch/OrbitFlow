import path from "node:path";

export interface ProductionWorkspaceToolsOptions {
  agentTool?: string;
  codingTool?: string;
}

export function createProductionWorkspaceTools(
  options: ProductionWorkspaceToolsOptions = {},
): (agentId: string, nodeId: string, ticketId: string | null, runId: string) => string {
  const agentTool = options.agentTool ?? path.resolve("bin/orbit-agent-tools.mjs");
  const codingTool = options.codingTool ?? path.resolve("bin/orbit-coding-tool.mjs");

  return (agentId, nodeId, ticketId, runId) => [
    `# OrbitFlow tools for ${nodeId}`,
    "ORBITFLOW_PLATFORM_DATABASE_URL is already bound to the platform database.",
    "Never print, replace, export, or invent its value.",
    "Replace <unique-suffix> with a new short value for each command invocation.",
    "Use only the commands required by the node prompt.",
    "",
    "### list_tickets",
    `DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" node ${agentTool} list_tickets '${JSON.stringify({
      agentId,
      runId,
      limit: 50,
      idempotencyKey: "list-<unique-suffix>",
    })}'`,
    "",
    "### create_ticket",
    `DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" node ${agentTool} create_ticket '${JSON.stringify({
      agentId,
      runId,
      projectId: "<projectId from the run spec or an existing ticket>",
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
      `DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" node ${agentTool} update_ticket '${JSON.stringify({
        agentId,
        runId,
        ticketId,
        expectedUpdatedAt: "<updatedAt from list_tickets>",
        status: "<backlog|todo|in_progress|done|canceled>",
        idempotencyKey: "update-<unique-suffix>",
      })}'`,
    ] : []),
    ...(ticketId ? [
      "",
      "### post_message",
      `DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" node ${agentTool} post_message '${JSON.stringify({
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
    `echo '${JSON.stringify({ command: "start_run_workspace", runId })}' | DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" ORBITFLOW_WORKSPACE_ROOT="$ORBITFLOW_WORKSPACE_ROOT" node ${codingTool}`,
    "",
    "### delegate_coding_task",
    "Replace <task> with a JSON-escaped task description.",
    `printf '%s\\n' "{\\\"command\\\":\\\"delegate_coding_task\\\",\\\"task\\\":\\\"<task>\\\",\\\"workspace\\\":\\\"$ORBITFLOW_WORKSPACE_ROOT/run-${runId}\\\"}" | DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" ORBITFLOW_RUN_ID=${runId} ORBITFLOW_AGENT_ID=${agentId} ORBITFLOW_WORKSPACE_ROOT="$ORBITFLOW_WORKSPACE_ROOT" node ${codingTool}`,
  ].join("\n");
}
