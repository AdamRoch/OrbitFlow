// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveRefresh } from "@/components/live-refresh";

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data?: string) {
    const event = new Event(type) as MessageEvent<string>;
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("LiveRefresh", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    refreshMock.mockReset();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<LiveRefresh />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("re-fetches on connection, valid wake-ups, and reconnects", () => {
    const stream = FakeEventSource.instances[0];
    expect(stream.url).toBe("/api/state-stream");

    act(() => stream.emit("open"));
    expect(refreshMock).toHaveBeenCalledOnce();

    act(() => stream.emit("state", JSON.stringify({
      schemaVersion: 1,
      type: "ticket.updated",
      runId: null,
      agentId: null,
      ticketId: "42",
      occurredAt: "2026-08-10T12:00:00.000Z",
    })));
    expect(refreshMock).toHaveBeenCalledTimes(2);

    act(() => stream.emit("open"));
    expect(refreshMock).toHaveBeenCalledTimes(3);
  });

  it("ignores malformed data and closes the connection on unmount", async () => {
    const stream = FakeEventSource.instances[0];
    act(() => stream.emit("state", "not json"));
    act(() => stream.emit("state", JSON.stringify({ type: "ticket.updated" })));
    expect(refreshMock).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    expect(stream.closed).toBe(true);
  });
});
