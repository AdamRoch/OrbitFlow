// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonitoringDashboard } from "@/components/monitoring-dashboard";
import type { MonitoringSnapshot } from "@/lib/control-plane/types";

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: replaceMock }) }));

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  closed = false;
  constructor(readonly url: string) { super(); FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
  emit(type: string, data?: string) {
    const event = new Event(type) as MessageEvent<string>;
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }
}

const snapshot: MonitoringSnapshot = {
  filters: { runId: null, agentId: null, messageType: null },
  readAt: "2026-08-10T12:00:00.000Z",
  runs: [{ id: "9", workflowName: "Release", status: "running", triggerType: "ui", workflowVersion: "2026-08-10T12:00:00.000Z", retryOfRunId: null, retryBlockedReason: null, createdAt: "2026-08-10T12:00:00.000Z" }],
  board: [{ id: "11", runId: "9", identifier: "FACT-11", title: "Observe the release", status: "in_progress", priority: 3, assigneeAgentId: "2", assigneeName: "Scout", updatedAt: "2026-08-10T12:00:00.000Z" }],
  trail: [{ id: "14", runId: "9", ticketId: "11", sequenceNumber: "1", sender: "agent:2", recipient: "telegram:adam", type: "question", payload: { body: "Ship?" }, handoffBrief: "Need approval", createdAt: "2026-08-10T12:00:00.000Z" }],
  runsTruncated: false, boardTruncated: false, trailTruncated: false, agentsTruncated: false, runCostsTruncated: false, agentCostsTruncated: false, agentOptionsTruncated: false,
  agents: [{ id: "2", name: "Scout", role: "worker", channel: null, status: "waiting-on-question", currentTask: { id: "11", identifier: "FACT-11", title: "Observe the release", runId: "9" }, logs: [], logsTruncated: false }],
  agentOptions: [{ id: "2", name: "Scout" }, { id: "3", name: "Operator" }],
  runCosts: [{ runId: "9", workflowName: "Release", tokensIn: "100", tokensOut: "10", totalTokens: "110", totalCost: "0.10000001" }],
  agentCosts: [{ runId: "9", workflowName: "Release", agentId: "2", agentName: "Scout", tokensIn: "100", tokensOut: "10", totalTokens: "110", totalCost: "0.10000001", costLimit: "0.2", overCostLimit: false }],
};

function snapshotWithTitle(title: string): MonitoringSnapshot {
  return { ...snapshot, board: [{ ...snapshot.board[0]!, title }] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MonitoringDashboard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    FakeEventSource.instances = [];
    replaceMock.mockReset();
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200 })));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<MonitoringDashboard initialSnapshot={snapshot} initialTab="board" />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("makes all tabs discoverable and re-fetches the PostgreSQL snapshot on stream wakes", async () => {
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(4);
    expect(container.textContent).toContain("FACT-11");
    const stream = FakeEventSource.instances[0]!;
    expect(stream.url).toBe("/api/state-stream");
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const before = fetchMock.mock.calls.length;
    await act(async () => stream.emit("state", JSON.stringify({ schemaVersion: 1, type: "ticket.updated", runId: "9", agentId: "2", ticketId: "11", occurredAt: "2026-08-10T12:00:01.000Z" })));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);

    await act(async () => (container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[3]!).click());
    expect(container.textContent).toContain("Per agent");
    expect(container.textContent).toContain("Within ceiling");
    expect(replaceMock).toHaveBeenCalledWith("/monitoring?tab=cost");
  });

  it("surfaces a pending UI approval and posts its correlated approving answer", async () => {
    const withApproval: MonitoringSnapshot = {
      ...snapshot,
      pendingQuestions: [{
        id: "24", runId: "9", ticketId: "11", ticketIdentifier: "FACT-11",
        kind: "approval", boundary: "before", route: "human-via-UI",
        questionText: "Approve starting workflow node implement?", createdAt: "2026-08-10T12:00:00.000Z",
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("/api/monitoring")
      ? new Response(JSON.stringify(withApproval), { status: 200 })
      : new Response(JSON.stringify({ replayed: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => FakeEventSource.instances[0]!.emit("state", JSON.stringify({ schemaVersion: 1, type: "question.created", runId: "9", agentId: null, ticketId: "11", occurredAt: "2026-08-10T12:00:01.000Z" })));
    expect(container.textContent).toContain("Approve starting workflow node implement?");
    const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === "Approve")!;
    await act(async () => button.click());
    expect(fetchMock).toHaveBeenCalledWith("/api/questions/24/answer", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ answer: "Approved", approved: true }),
    }));
    expect(container.textContent).toContain("Submitted");
  });

  it("keeps the displayed snapshot and declares degradation when refetching fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await act(async () => FakeEventSource.instances[0]!.emit("state", JSON.stringify({ schemaVersion: 1, type: "cost.created", runId: "9", agentId: "2", ticketId: null, occurredAt: "2026-08-10T12:00:01.000Z" })));
    expect(container.textContent).toContain("Live refresh is unavailable");
    expect(container.textContent).toContain("Degraded snapshot");
    expect(container.textContent).not.toContain("Snapshot current");
    expect(container.textContent).toContain("FACT-11");
  });

  it("supersedes an older filter refresh when requests complete in reverse order", async () => {
    const requests: ReturnType<typeof deferred<Response>>[] = [];
    vi.stubGlobal("fetch", vi.fn(() => {
      const request = deferred<Response>();
      requests.push(request);
      return request.promise;
    }));
    const stream = FakeEventSource.instances[0]!;
    await act(async () => stream.emit("open"));
    expect(requests).toHaveLength(1);

    const agent = container.querySelectorAll<HTMLSelectElement>("select")[1]!;
    await act(async () => {
      agent.value = "2";
      agent.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(requests).toHaveLength(2);

    await act(async () => requests[1]!.resolve(new Response(JSON.stringify(snapshotWithTitle("Newest snapshot")), { status: 200 })));
    expect(container.textContent).toContain("Newest snapshot");
    await act(async () => requests[0]!.resolve(new Response(JSON.stringify(snapshotWithTitle("Stale snapshot")), { status: 200 })));
    expect(container.textContent).toContain("Newest snapshot");
    expect(container.textContent).not.toContain("Stale snapshot");
  });

  it("coalesces a burst of stream wakes into one follow-up snapshot read", async () => {
    const requests: ReturnType<typeof deferred<Response>>[] = [];
    vi.stubGlobal("fetch", vi.fn(() => {
      const request = deferred<Response>();
      requests.push(request);
      return request.promise;
    }));
    const stream = FakeEventSource.instances[0]!;
    await act(async () => {
      stream.emit("open");
      stream.emit("state", JSON.stringify({ schemaVersion: 1, type: "ticket.updated", runId: "9", agentId: "2", ticketId: "11", occurredAt: "2026-08-10T12:00:01.000Z" }));
      stream.emit("state", JSON.stringify({ schemaVersion: 1, type: "message.created", runId: "9", agentId: "2", ticketId: "11", occurredAt: "2026-08-10T12:00:02.000Z" }));
      stream.emit("state", JSON.stringify({ schemaVersion: 1, type: "cost.created", runId: "9", agentId: "2", ticketId: null, occurredAt: "2026-08-10T12:00:03.000Z" }));
    });
    expect(requests).toHaveLength(1);
    await act(async () => requests[0]!.resolve(new Response(JSON.stringify(snapshot), { status: 200 })));
    expect(requests).toHaveLength(2);
    await act(async () => requests[1]!.resolve(new Response(JSON.stringify(snapshot), { status: 200 })));
  });

  it("keeps transport and snapshot status honest across EventSource disconnect and recovery", async () => {
    const recovery = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => recovery.promise));
    const stream = FakeEventSource.instances[0]!;

    // Disconnected transport: the listener is reconnecting and the last
    // authoritative snapshot is retained. It must never claim to be connected.
    await act(async () => stream.emit("error"));
    expect(container.textContent).toContain("Degraded snapshot");
    expect(container.textContent).toContain("Live listener reconnecting");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Live listener is reconnecting. Showing the last authoritative snapshot.");
    expect(container.textContent).not.toContain("Live listener is connected. Waiting for an authoritative snapshot.");

    // Transport back, recovery fetch still pending: connected and awaiting the
    // authoritative snapshot, and no longer claiming to reconnect.
    await act(async () => stream.emit("open"));
    expect(container.textContent).toContain("Live listener connected");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Live listener is connected. Waiting for an authoritative snapshot.");
    expect(container.textContent).not.toContain("Live listener reconnecting");
    expect(container.textContent).not.toContain("Snapshot current");

    // Recovery succeeded: both degraded branches clear.
    await act(async () => recovery.resolve(new Response(JSON.stringify(snapshot), { status: 200 })));
    expect(container.textContent).toContain("Snapshot current");
    expect(container.textContent).not.toContain("Waiting for an authoritative snapshot");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("discharges the recovery debt when Retry snapshot succeeds after a failed recovery fetch", async () => {
    const failedRecovery = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => failedRecovery.promise));
    const stream = FakeEventSource.instances[0]!;
    await act(async () => stream.emit("error"));
    await act(async () => stream.emit("open"));

    // The epoch-matched recovery fetch fails: the page honestly reports the
    // unavailable refresh and retains the last successful snapshot.
    await act(async () => failedRecovery.resolve(new Response("nope", { status: 503 })));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Live refresh is unavailable. Showing the last successful snapshot.");

    // The page's own Retry snapshot succeeds: the fresh authoritative read
    // clears both the refresh failure and the recovery debt.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshotWithTitle("Retried snapshot")), { status: 200 })));
    await act(async () => container.querySelector<HTMLButtonElement>('[role="status"] button')!.click());
    expect(container.textContent).toContain("Retried snapshot");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain("Snapshot current");
    expect(container.textContent).not.toContain("Waiting for an authoritative snapshot");
  });

  it("discharges the recovery debt when a filter supersede read succeeds while recovery is pending", async () => {
    const requests: ReturnType<typeof deferred<Response>>[] = [];
    vi.stubGlobal("fetch", vi.fn(() => {
      const request = deferred<Response>();
      requests.push(request);
      return request.promise;
    }));
    const stream = FakeEventSource.instances[0]!;
    await act(async () => stream.emit("error"));
    await act(async () => stream.emit("open"));
    expect(requests).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Waiting for an authoritative snapshot.");

    // A filter change supersedes the pending recovery fetch; its successful
    // read began after the disconnect and discharges the recovery debt.
    const agent = container.querySelectorAll<HTMLSelectElement>("select")[1]!;
    await act(async () => {
      agent.value = "2";
      agent.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(requests).toHaveLength(2);
    await act(async () => requests[1]!.resolve(new Response(JSON.stringify(snapshot), { status: 200 })));
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain("Snapshot current");
    expect(container.textContent).not.toContain("Waiting for an authoritative snapshot");
  });

  it("does not let a pre-disconnect read clear the recovery debt after a newer disconnect", async () => {
    const requests: ReturnType<typeof deferred<Response>>[] = [];
    vi.stubGlobal("fetch", vi.fn(() => {
      const request = deferred<Response>();
      requests.push(request);
      return request.promise;
    }));
    const stream = FakeEventSource.instances[0]!;
    await act(async () => stream.emit("open"));
    await act(async () => requests[0]!.resolve(new Response(JSON.stringify(snapshot), { status: 200 })));
    expect(container.textContent).toContain("Snapshot current");

    // A wake-driven read starts while healthy, then the transport drops
    // before it completes.
    await act(async () => stream.emit("state", JSON.stringify({ schemaVersion: 1, type: "ticket.updated", runId: "9", agentId: "2", ticketId: "11", occurredAt: "2026-08-10T12:00:01.000Z" })));
    expect(requests).toHaveLength(2);
    await act(async () => stream.emit("error"));

    // The stale pre-disconnect read succeeds: it must not clear the debt.
    await act(async () => requests[1]!.resolve(new Response(JSON.stringify(snapshot), { status: 200 })));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Live listener is reconnecting. Showing the last authoritative snapshot.");
    expect(container.textContent).not.toContain("Snapshot current");

    // Only the epoch-matched post-disconnect recovery read clears it.
    await act(async () => stream.emit("open"));
    expect(requests).toHaveLength(3);
    await act(async () => requests[2]!.resolve(new Response(JSON.stringify(snapshot), { status: 200 })));
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain("Snapshot current");
  });

  it("uses roving tab focus and keeps all selected-run agent choices after filtering", async () => {
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[0]!.tabIndex).toBe(0);
    expect(tabs[1]!.tabIndex).toBe(-1);
    await act(async () => tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe("monitoring-tab-trail");

    const agent = container.querySelectorAll<HTMLSelectElement>("select")[1]!;
    await act(async () => {
      agent.value = "2";
      agent.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect([...agent.options].map((option) => option.text)).toEqual(["All agents", "Scout", "Operator"]);
  });
});
