// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowEditor } from "@/components/workflow-editor";
import type { AgentDTO, WorkflowDTO } from "@/lib/control-plane/types";
import type { WorkflowGraph } from "@/lib/workflow/graph-contract";

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    MiniMap: () => null,
    MarkerType: { ArrowClosed: "arrowclosed" },
    Position: { Left: "left", Right: "right" },
    ReactFlow: ({ nodes, edges, onNodeClick, onEdgeClick, children }: {
      nodes: Array<{ id: string }>;
      edges: Array<{ id: string; source: string; target: string }>;
      onNodeClick: (event: unknown, node: { id: string }) => void;
      onEdgeClick: (event: unknown, edge: { id: string }) => void;
      children: React.ReactNode;
    }) => React.createElement(
      "div",
      { "aria-label": "Mock workflow canvas" },
      ...nodes.map((node) => React.createElement("button", { key: node.id, type: "button", onClick: (event) => onNodeClick(event, node) }, `Node ${node.id}`)),
      ...edges.map((edge) => React.createElement("button", { key: edge.id, type: "button", onClick: (event) => onEdgeClick(event, edge) }, `Edge ${edge.source} to ${edge.target}`)),
      children,
    ),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, name: string): AgentDTO => ({
  id,
  name,
  role: "operator",
  systemPrompt: "Follow the workflow contract.",
  model: "openrouter/test",
  codingToolEnabled: false,
  guardrails: {},
  interactionRules: {},
  channelBinding: null,
  memory: {},
  openclawRef: null,
  skills: [],
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
});

const workflow: WorkflowDTO = {
  id: "7",
  name: "Rejection loop",
  description: "Implement, test, and loop on rejection.",
  isTemplate: false,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
  graph: {
    nodes: [
      { id: "implement", agentId: "1", config: { entry: true, planMode: "allowed", may_answer_questions: false, futureEngineField: { keep: true } } },
      { id: "test", agentId: "2", config: { entry: false } },
    ],
    edges: [
      { source: "implement", target: "test", condition: { operator: "always" } },
      { source: "test", target: "implement", condition: { operator: "equals", path: ["verdict"], value: "rejected" }, futureEdgeField: ["keep"] },
    ],
    builderMetadata: { positions: { implement: { x: 10, y: 20 }, test: { x: 300, y: 20 } }, futureBuilderField: "keep" },
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === text)!;
}

function findControl<T extends HTMLInputElement | HTMLSelectElement>(container: HTMLElement, label: string): T {
  const field = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent?.includes(label));
  return field!.querySelector<T>("input, select")!;
}

function click(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("change", { bubbles: true }));
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("WorkflowEditor", () => {
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
    vi.unstubAllGlobals();
  });

  async function renderAndLoad() {
    await act(async () => root.render(<WorkflowEditor />));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await Promise.resolve();
    });
  }

  it("edits the rejection loop and saves the exact graph while preserving unknown fields", async () => {
    let patchBody: Record<string, unknown> | undefined;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/agents") return Promise.resolve(json([agent("1", "Implementer"), agent("2", "Tester")]));
      if (url === "/api/workflows") return Promise.resolve(json([workflow]));
      if (url === "/api/workflows/7" && init?.method === "PATCH") {
        patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Promise.resolve(json({ ...workflow, ...patchBody, updatedAt: "2026-08-10T00:01:00.000Z" }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    await renderAndLoad();

    expect(container.textContent).toContain("Cycles are allowed");
    expect(container.querySelector('[aria-label="Plan mode guidance"]')?.getAttribute("title")).toContain("Cheaper models");

    await act(async () => change(findControl<HTMLSelectElement>(container, "Plan mode"), "required"));
    await act(async () => click(findControl<HTMLInputElement>(container, "May answer questions")));
    await act(async () => {
      click(findButton(container, "Edge test to implement"));
      await Promise.resolve();
    });
    await act(async () => change(findControl<HTMLInputElement>(container, "JSON value"), '"rejected-again"'));
    await act(async () => {
      click(findButton(container, "Save workflow"));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const savedGraph = patchBody!.graph as WorkflowGraph;
    expect(patchBody!.expectedUpdatedAt).toBe(workflow.updatedAt);
    expect(savedGraph.nodes).toEqual([
      { id: "implement", agentId: "1", config: { entry: true, planMode: "required", may_answer_questions: true, futureEngineField: { keep: true } } },
      (workflow.graph as unknown as WorkflowGraph).nodes[1],
    ]);
    expect(savedGraph.edges[1]).toEqual({
      source: "test",
      target: "implement",
      condition: { operator: "equals", path: ["verdict"], value: "rejected-again" },
      futureEdgeField: ["keep"],
    });
    expect(savedGraph.builderMetadata).toEqual(workflow.graph.builderMetadata);
  });

  it("surfaces an optimistic save conflict without claiming success", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/agents") return Promise.resolve(json([agent("1", "Implementer"), agent("2", "Tester")]));
      if (url === "/api/workflows") return Promise.resolve(json([workflow]));
      if (url === "/api/workflows/7" && init?.method === "PATCH") return Promise.resolve(json({ error: { code: "stale_update", message: "stale" } }, 409));
      throw new Error(`unexpected request: ${url}`);
    });
    await renderAndLoad();
    await act(async () => {
      click(findButton(container, "Save workflow"));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Save conflict");
    expect(container.textContent).not.toContain("Saved to PostgreSQL");
  });
});
