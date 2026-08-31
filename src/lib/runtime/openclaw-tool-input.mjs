const RESERVED_FIELDS = new Set(["agentId", "runId", "ticketId", "workspace", "command"]);

export function validateOpenClawToolInput(command, supplied) {
  for (const field of Object.keys(supplied)) {
    const plannerDependencyTarget = command === "set_ticket_dependencies" && field === "ticketId";
    if (RESERVED_FIELDS.has(field) && !plannerDependencyTarget) {
      throw new Error(`${field} is bound by the active dispatch`);
    }
  }
}
