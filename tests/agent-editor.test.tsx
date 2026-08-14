// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEditor } from "@/components/agent-editor";
import type { AgentDTO, ScheduleDTO } from "@/lib/control-plane/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, name: string): AgentDTO => ({
  id, name, role: "operator", systemPrompt: "Keep the control plane tidy.", model: "openrouter/test",
  codingToolEnabled: false, guardrails: {}, interactionRules: {}, channelBinding: null, memory: {}, openclawRef: null,
  skills: [], createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z",
});
const modelProps = { availableModels: ["openrouter/test"], primaryModel: "openrouter/test" } as const;

const schedule = (id: string, agentId: string, taskPrompt: string): ScheduleDTO => ({
  id, agentId, workflowId: null, cronExpression: "0 9 * * 1-5", taskPrompt, enabled: true,
  createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function click(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AgentEditor regressions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderAndLoad() {
    await act(async () => {
      root.render(<AgentEditor {...modelProps} />);
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await Promise.resolve();
    });
  }

  it("does not apply an older agent's schedules after a faster selection", async () => {
    const firstSchedules = deferred<Response>();
    const secondSchedules = deferred<Response>();
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/agents") return Promise.resolve(json([agent("1", "Agent A"), agent("2", "Agent B")]));
      if (url === "/api/skills") return Promise.resolve(json([]));
      if (url === "/api/agents/1/schedules") return firstSchedules.promise;
      if (url === "/api/agents/2/schedules") return secondSchedules.promise;
      throw new Error(`unexpected request: ${url}`);
    });
    await renderAndLoad();

    await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Agent A"))!));
    await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Agent B"))!));
    await act(async () => { secondSchedules.resolve(json([schedule("2", "2", "B standing task")])); await Promise.resolve(); });
    await act(async () => { firstSchedules.resolve(json([schedule("1", "1", "A standing task")])); await Promise.resolve(); });

    expect(container.textContent).toContain("B standing task");
    expect(container.textContent).not.toContain("A standing task");
  });

  it("keeps the roster shrinkable and gives checkbox controls stable form identities", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/agents") return Promise.resolve(json([agent("1", "Agent A")]));
      if (url === "/api/skills" || url === "/api/agents/1/schedules") return Promise.resolve(json([]));
      throw new Error(`unexpected request: ${url}`);
    });
    await renderAndLoad();
    await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Agent A"))!));
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector("aside")?.className).toContain("min-w-0");
    expect(container.querySelector<HTMLInputElement>("#agent-coding-tool-enabled")?.name).toBe("codingToolEnabled");
    expect(container.querySelector<HTMLInputElement>("#agent-may-answer-questions")?.name).toBe("mayAnswerQuestions");
    expect(container.querySelector<HTMLInputElement>("#schedule-enabled")?.name).toBe("scheduleEnabled");
    await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent === "Add fact")!));
    expect(container.querySelector<HTMLInputElement>('[aria-label="Memory fact 1"]')?.name).toBe("memoryFact1");
  });

  it("preserves opaque JSON while saving an unrelated dedicated field", async () => {
    const opaqueAgent = {
      ...agent("1", "Opaque Agent"),
      guardrails: { rateLimit: ["legacy", { burst: 2 }], blockedActions: { deny: ["deploy"] }, nested: { keep: true } },
      interactionRules: { mayAnswerQuestions: { inherited: true }, policy: { route: "human" } },
      channelBinding: { provider: { opaque: true }, destination: ["42"] },
      memory: { facts: { legacy: "value" }, provenance: { source: "import" } },
    };
    let patchBody: Record<string, unknown> | undefined;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/agents") return Promise.resolve(json([opaqueAgent]));
      if (url === "/api/skills" || url === "/api/agents/1/schedules") return Promise.resolve(json([]));
      if (url === "/api/agents/1" && init?.method === "PATCH") {
        patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Promise.resolve(json({ ...opaqueAgent, systemPrompt: "Changed without rewriting opaque values." }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    await renderAndLoad();
    await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Opaque Agent"))!));
    await act(async () => { await Promise.resolve(); });
    await act(async () => change(container.querySelector("#agent-prompt")!, "Changed without rewriting opaque values."));
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(patchBody).toMatchObject({
      guardrails: opaqueAgent.guardrails,
      interactionRules: opaqueAgent.interactionRules,
      channelBinding: opaqueAgent.channelBinding,
      memory: opaqueAgent.memory,
    });
  });

  it("keeps destructive confirmation modal, dismissible, and restores focus", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/agents") return Promise.resolve(json([agent("1", "Delete Me")]));
      if (url === "/api/skills" || url === "/api/agents/1/schedules") return Promise.resolve(json([]));
      throw new Error(`unexpected request: ${url}`);
    });
    await renderAndLoad();
    await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Delete Me"))!));
    await act(async () => { await Promise.resolve(); });
    const deleteButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Delete agent")!;
    deleteButton.focus();
    await act(async () => { click(deleteButton); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    expect(dialog.getAttribute("aria-describedby")).toBe("delete-description");
    expect(container.hasAttribute("inert")).toBe(true);
    expect(document.activeElement?.textContent).toContain("Cancel");

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(deleteButton);
  });

  it("makes layout-level controls inert while either deletion dialog is open", async () => {
    let outsideClicks = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/agents") return Promise.resolve(json([agent("1", "Delete Me")]));
      if (url === "/api/skills") return Promise.resolve(json([]));
      if (url === "/api/agents/1/schedules") return Promise.resolve(json([schedule("1", "1", "Standing task")]));
      throw new Error(`unexpected request: ${url}`);
    });
    await act(async () => root.render(<><button onClick={() => { outsideClicks += 1; }}>Layout navigation</button><AgentEditor {...modelProps} /></>));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); await Promise.resolve(); });
    await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Delete Me"))!));
    await act(async () => { await Promise.resolve(); });

    const outside = [...container.querySelectorAll("button")].find((button) => button.textContent === "Layout navigation")!;
    const openDialog = async (label: string) => {
      await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent === label)!));
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
      expect(container.hasAttribute("inert")).toBe(true);
      expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
      outside.focus();
      expect(document.activeElement?.textContent).toContain("Cancel");
      await act(async () => click(outside));
      expect(outsideClicks).toBe(0);
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(container.hasAttribute("inert")).toBe(false);
    };

    await openDialog("Delete agent");
    await openDialog("Delete");
  });

  it("only sends a manual trigger after a deliberate click and gives each click a fresh request identity", async () => {
    const requestBodies: { idempotencyKey: string }[] = [];
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce("first-click").mockReturnValueOnce("second-click");
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/agents") return Promise.resolve(json([agent("1", "Trigger Agent")]));
      if (url === "/api/skills") return Promise.resolve(json([]));
      if (url === "/api/agents/1/schedules") return Promise.resolve(json([schedule("7", "1", "Run the standing task")]));
      if (url === "/api/schedules/7/trigger" && init?.method === "POST") {
        requestBodies.push(JSON.parse(String(init.body)));
        return Promise.resolve(json({ kind: "created", scheduleId: "7", tickKey: "manual:test", runId: String(41 + requestBodies.length), messageId: "9" }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    await renderAndLoad();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/trigger"))).toBe(false);

    await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Trigger Agent"))!));
    await act(async () => { await Promise.resolve(); });
    const triggerButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Trigger now")!;
    await act(async () => click(triggerButton));
    await act(async () => { await Promise.resolve(); });
    await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent === "Trigger now")!));
    await act(async () => { await Promise.resolve(); });

    expect(requestBodies).toEqual([{ idempotencyKey: "schedule-trigger:first-click" }, { idempotencyKey: "schedule-trigger:second-click" }]);
    expect(container.textContent).toContain("Run #43 created.");
    const createdRunLink = [...container.querySelectorAll("a")].find((link) => link.textContent === "View in Monitoring");
    expect(createdRunLink?.getAttribute("href")).toBe("/monitoring?tab=board&runId=43");
  });

  it("blocks a second click until the first trigger request completes", async () => {
    const pending = deferred<Response>();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("one-click");
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/agents") return Promise.resolve(json([agent("1", "Trigger Agent")]));
      if (url === "/api/skills") return Promise.resolve(json([]));
      if (url === "/api/agents/1/schedules") return Promise.resolve(json([schedule("7", "1", "Run the standing task")]));
      if (url === "/api/schedules/7/trigger" && init?.method === "POST") return pending.promise;
      throw new Error(`unexpected request: ${url}`);
    });
    await renderAndLoad();
    await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Trigger Agent"))!));
    await act(async () => { await Promise.resolve(); });
    const triggerButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Trigger now")!;
    await act(async () => { click(triggerButton); click(triggerButton); });

    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/schedules/7/trigger")).toHaveLength(1);
    expect(container.textContent).toContain("Triggering…");
    expect(triggerButton.disabled).toBe(true);

    await act(async () => { pending.resolve(json({ kind: "duplicate", scheduleId: "7", tickKey: "manual:one-click", runId: "42", messageId: "9" })); await Promise.resolve(); });
    expect(container.textContent).toContain("Existing run #42 returned for this request.");
    const duplicateRunLink = [...container.querySelectorAll("a")].find((link) => link.textContent === "View in Monitoring");
    expect(duplicateRunLink?.getAttribute("href")).toBe("/monitoring?tab=board&runId=42");
  });

  it("shows an honest trigger failure beside the schedule", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("fails");
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/agents") return Promise.resolve(json([agent("1", "Trigger Agent")]));
      if (url === "/api/skills") return Promise.resolve(json([]));
      if (url === "/api/agents/1/schedules") return Promise.resolve(json([schedule("7", "1", "Run the standing task")]));
      if (url === "/api/schedules/7/trigger" && init?.method === "POST") return Promise.resolve(json({ error: { message: "Schedule service unavailable" } }, 503));
      throw new Error(`unexpected request: ${url}`);
    });
    await renderAndLoad();
    await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Trigger Agent"))!));
    await act(async () => { await Promise.resolve(); });
    await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent === "Trigger now")!));
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Trigger failed: Schedule service unavailable");
  });
});
