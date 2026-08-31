export interface ProductionWorkspaceToolsOptions {
  tool?: string;
}

export function createProductionWorkspaceTools(
  options: ProductionWorkspaceToolsOptions = {},
): (agentId: string, nodeId: string, ticketId: string | null, runId: string) => string {
  const tool = options.tool ?? "/app/bin/orbit-openclaw-tool.mjs";

  return (_agentId, nodeId, ticketId, _runId) => [
    `# OrbitFlow tools for ${nodeId}`,
    "The active dispatch binds agent, run, ticket, database, and workspace context.",
    "Never supply or attempt to replace those bound fields.",
    "Replace <unique-suffix> with a new short value for each command invocation.",
    "Use only the commands required by the node prompt.",
    "",
    "### list_projects",
    `${tool} list_projects '${JSON.stringify({
      limit: 50,
      idempotencyKey: "projects-<unique-suffix>",
    })}'`,
    "Use a returned project id for create_ticket. Never invent a project id.",
    "",
    "### list_tickets",
    `${tool} list_tickets '${JSON.stringify({
      limit: 50,
      idempotencyKey: "list-<unique-suffix>",
    })}'`,
    "",
    "### create_ticket",
    `${tool} create_ticket '${JSON.stringify({
      projectId: "<projectId from list_projects>",
      title: "<title>",
      description: "<description or null>",
      acceptanceCriteria: "<acceptance criteria or null>",
      status: "todo",
      priority: 1,
      idempotencyKey: "create-<unique-suffix>",
    })}'`,
    ...(ticketId ? [] : [
      "",
      "A planner dispatch has no active ticket. Include the target ticketId from list_tickets when setting dependencies.",
    ]),
    "",
    "### set_ticket_dependencies",
    `${tool} set_ticket_dependencies '${JSON.stringify({
      ...(ticketId ? {} : { ticketId: "<ticketId from list_tickets>" }),
      blockerTicketIds: ["<ticketId from list_tickets>"],
      idempotencyKey: "dependencies-<unique-suffix>",
    })}'`,
    ...(ticketId ? [
      "",
      "### update_ticket",
      `${tool} update_ticket '${JSON.stringify({
        expectedUpdatedAt: "<updatedAt from list_tickets>",
        status: "<backlog|todo|done|canceled>",
        idempotencyKey: "update-<unique-suffix>",
      })}'`,
      "",
      "### post_message",
      `${tool} post_message '${JSON.stringify({
        recipient: "<recipient>",
        type: "<output|feedback|question|answer|system>",
        payload: {},
        handoffBrief: "<handoff brief or null>",
        idempotencyKey: "message-<unique-suffix>",
      })}'`,
    ] : []),
    "",
    "### start_run_workspace",
    `${tool} start_run_workspace '{}'`,
    "Use the returned workspace only through delegate_coding_task.",
    "",
    "### delegate_coding_task",
    "Replace <task> with a JSON-escaped and shell-quoted task description.",
    `${tool} delegate_coding_task '${JSON.stringify({ task: "<task>" })}'`,
  ].join("\n");
}
