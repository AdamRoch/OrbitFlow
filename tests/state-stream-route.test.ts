import { describe, expect, it } from "vitest";
import { stateStreamResponse } from "@/app/api/state-stream/route";
import type { StateEventListener } from "@/lib/state-events";

describe("state stream route", () => {
  it("cleans up a disconnected or backpressured client without retaining a queue", async () => {
    const abort = new AbortController();
    let listener: StateEventListener | undefined;
    let unsubscribed = 0;
    const response = stateStreamResponse(
      new Request("http://orbitfactory.test/api/state-stream?malformed=ignored", {
        signal: abort.signal,
      }),
      (nextListener) => {
        listener = nextListener;
        return () => { unsubscribed += 1; };
      },
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(listener).toBeDefined();
    const event = {
      schemaVersion: 1 as const,
      type: "ticket.updated" as const,
      runId: null,
      agentId: null,
      ticketId: "42",
      occurredAt: "2026-08-10T12:00:00.000Z",
    };
    listener!(event);
    listener!(event);
    expect(unsubscribed).toBe(1);

    abort.abort();
    expect(unsubscribed).toBe(1);
  });
});
