// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteNav } from "@/components/site-nav";

vi.mock("next/navigation", () => ({ usePathname: () => "/monitoring" }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SiteNav mobile dialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<><SiteNav /><main><button type="button">Covered content</button></main></>));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("contains focus, hides covered content, and returns focus to the toggle on Escape", async () => {
    const toggle = container.querySelector<HTMLButtonElement>("button[aria-label='Toggle menu']")!;
    await act(async () => toggle.click());
    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    const links = [...dialog.querySelectorAll<HTMLAnchorElement>("a")];
    expect(document.querySelector("main")?.hasAttribute("inert")).toBe(true);
    expect(document.querySelector("main")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(links[0]);

    links.at(-1)!.focus();
    await act(async () => links.at(-1)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(links[0]);
    links[0]!.focus();
    await act(async () => links[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })));
    expect(document.activeElement).toBe(links.at(-1));

    await act(async () => links[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(document.querySelector("main")?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });
});
