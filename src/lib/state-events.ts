export const STATE_EVENT_TYPES = [
  "state.resync",
  "ticket.created",
  "ticket.updated",
  "ticket.deleted",
  "message.created",
  "question.created",
  "question.updated",
  "run.created",
  "run.updated",
  "run.deleted",
  "agent.created",
  "agent.updated",
  "agent.deleted",
  "cost.created",
] as const;

export type StateEventType = (typeof STATE_EVENT_TYPES)[number];

/**
 * A deliberately small, versioned wake-up envelope. The referenced rows remain
 * authoritative: consumers refresh their snapshot after receiving this event.
 */
export interface StateEvent {
  schemaVersion: 1;
  type: StateEventType;
  runId: string | null;
  agentId: string | null;
  ticketId: string | null;
  occurredAt: string;
}

export type StateEventListener = (event: StateEvent) => void;

const eventTypes = new Set<string>(STATE_EVENT_TYPES);

function identifier(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return value;
  return null;
}

/** Parse only the stable public envelope; malformed notifications are ignored. */
export function parseStateEvent(value: unknown): StateEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (event.schemaVersion !== 1 || typeof event.type !== "string" || !eventTypes.has(event.type)) {
    return null;
  }
  const runId = identifier(event.runId);
  const agentId = identifier(event.agentId);
  const ticketId = identifier(event.ticketId);
  if (
    (event.runId !== null && runId === null) ||
    (event.agentId !== null && agentId === null) ||
    (event.ticketId !== null && ticketId === null) ||
    typeof event.occurredAt !== "string" ||
    Number.isNaN(Date.parse(event.occurredAt))
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    type: event.type as StateEventType,
    runId,
    agentId,
    ticketId,
    occurredAt: event.occurredAt,
  };
}
