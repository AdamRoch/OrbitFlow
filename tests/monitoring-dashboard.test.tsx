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
  runs: [{ id: "9", workflowName: "Release", status: "running", triggerType: "ui", createdAt: "2026-08-10T12:00:00.000Z" }],
  board: [{ id: "11", runId: "9", identifier: "FACT-11", title: "Observe the release", status: "in_progress", priority: 3, assigneeAgentId: "2", assigneeName: "Scout", updatedAt: "2026-08-10T12:00:00.000Z" }],
  trail: [{ id: "14", runId: "9", ticketId: "11", sequenceNumber: "1", sender: "agent:2", recipient: "telegram:adam", type: "question", payload: { body: "Ship?" }, handoffBrief: "Need approval", createdAt: "2026-08-10T12:00:00.000Z" }],
  trailTruncated: false,
  agents: [{ id: "2", name: "Scout", role: "worker", status: "waiting-on-question", currentTask: { id: "11", identifier: "FACT-11", title: "Observe the release", runId: "9" }, logs: [] }],
  runCosts: [{ runId: "9", workflowName: "Release", tokensIn: "100", tokensOut: "10", totalTokens: "110", totalCost: "0.10000001" }],
  agentCosts: [{ runId: "9", workflowName: "Release", agentId: "2", agentName: "Scout", tokensIn: "100", tokensOut: "10", totalTokens: "110", totalCost: "0.10000001", costLimit: "0.2", overCostLimit: false }],
};

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

  it("keeps the displayed snapshot and declares degradation when refetching fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await act(async () => FakeEventSource.instances[0]!.emit("state", JSON.stringify({ schemaVersion: 1, type: "cost.created", runId: "9", agentId: "2", ticketId: null, occurredAt: "2026-08-10T12:00:01.000Z" })));
    expect(container.textContent).toContain("Live refresh is unavailable");
    expect(container.textContent).toContain("FACT-11");
  });
});
