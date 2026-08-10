// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_REFRESH_INTERVAL_MS,
  LiveRefresh,
} from "@/components/live-refresh";

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("LiveRefresh", () => {
  let container: HTMLDivElement;
  let root: Root;
  let visibilityState: DocumentVisibilityState;
  let visibilitySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    refreshMock.mockReset();
    visibilityState = "visible";
    visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibilityState);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<LiveRefresh />);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    visibilitySpy.mockRestore();
    vi.useRealTimers();
  });

  it("soft-refreshes the route on the configured interval", () => {
    act(() => vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS - 1));
    expect(refreshMock).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(refreshMock).toHaveBeenCalledOnce();

    act(() => vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS * 2));
    expect(refreshMock).toHaveBeenCalledTimes(3);
  });

  it("pauses while hidden and refreshes immediately when visible again", () => {
    visibilityState = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS * 2);
    });
    expect(refreshMock).not.toHaveBeenCalled();

    visibilityState = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(refreshMock).toHaveBeenCalledOnce();

    act(() => vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS));
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });
});
