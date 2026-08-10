// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteNav } from "@/components/site-nav";

const { route } = vi.hoisted(() => ({ route: { pathname: "/" } }));

vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("SiteNav", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    route.pathname = "/";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<SiteNav />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.style.overflow = "";
  });

  it("closes the mobile menu when the route changes", async () => {
    const menuButton = () =>
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Toggle menu"]',
      )!;

    await act(async () => menuButton().click());
    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");

    route.pathname = "/frontier";
    await act(async () => root.render(<SiteNav />));

    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps closed mobile navigation out of the accessibility tree and Tab order", () => {
    expect(
      container.querySelector('nav[aria-label="Mobile navigation"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('nav[aria-label="Mobile navigation"] a'),
    ).toHaveLength(0);
  });

  it("exposes mobile destinations when the menu opens", async () => {
    const menuButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle menu"]',
    )!;

    await act(async () => menuButton.click());

    const mobileNavigation = container.querySelector<HTMLElement>(
      'nav[aria-label="Mobile navigation"]',
    );
    expect(mobileNavigation).not.toBeNull();
    expect(mobileNavigation?.querySelector('a[href="/agents"]')?.textContent).toContain(
      "Agents",
    );
    expect(mobileNavigation?.querySelector('a[href="/workflows"]')?.textContent).toContain(
      "Workflows",
    );
    expect(mobileNavigation?.querySelectorAll("a")).toHaveLength(6);
  });
});
