export function buildPlatformCommandInput(command, supplied, context, fullContext) {
  const requiresActiveTicket = command === "update_ticket" || command === "post_message";
  const forceActiveTicket = requiresActiveTicket
    || (command === "set_ticket_dependencies" && context.ticketId !== null);
  if (requiresActiveTicket && context.ticketId === null) {
    throw new Error(`${command} requires a ticket-bound dispatch`);
  }
  return {
    ...supplied,
    agentId: context.agentId,
    runId: context.runId,
    ...(forceActiveTicket
      ? { ticketId: fullContext.ticketId }
      : {}),
  };
}
