import { describe, expect, it } from "vitest";
import {
  WorkflowGraphError,
  evaluateGraph,
  parseWorkflowGraph,
  predicateMatches,
} from "../src/lib/workflow/graph";
import { parseWorkflowGraph as parseControlPlaneWorkflowGraph } from "../src/lib/workflow/graph-contract";

const graphValue = {
  nodes: [
    { id: "implement", agentId: "1", config: { entry: true } },
    { id: "test", agentId: "2", config: {} },
    { id: "report", agentId: "3", config: {} },
  ],
  edges: [
    { source: "implement", target: "test", condition: { operator: "always" } },
    {
      source: "test",
      target: "implement",
      condition: { operator: "equals", path: ["verdict"], value: "rejected" },
    },
    {
      source: "test",
      target: "report",
      condition: { operator: "equals", path: ["verdict"], value: "approved" },
    },
  ],
};

describe("pure workflow graph evaluation", () => {
  it("uses the control-plane parser without projecting stored graph JSON", () => {
    expect(parseWorkflowGraph).toBe(parseControlPlaneWorkflowGraph);
    expect(parseWorkflowGraph(graphValue)).toBe(graphValue);
  });

  it("traverses a rejection cycle without special-casing the loop", () => {
    const graph = parseWorkflowGraph(graphValue);
    const first = evaluateGraph(graph, "implement", { artifact: "change" });
    expect(first).toMatchObject({ kind: "dispatch", node: { id: "test" } });

    const rejected = evaluateGraph(graph, "test", { verdict: "rejected" });
    expect(rejected).toMatchObject({ kind: "dispatch", node: { id: "implement" } });

    const retried = evaluateGraph(graph, "implement", { artifact: "fixed" });
    expect(retried).toMatchObject({ kind: "dispatch", node: { id: "test" } });

    const approved = evaluateGraph(graph, "test", { verdict: "approved" });
    expect(approved).toMatchObject({ kind: "dispatch", node: { id: "report" } });
    expect(evaluateGraph(graph, "report", { artifact: "done" })).toEqual({
      kind: "complete",
    });
  });

  it("uses declared edge order as deterministic transition priority", () => {
    const graph = parseWorkflowGraph({
      nodes: [
        { id: "start", agentId: 1, config: { entry: true } },
        { id: "first", agentId: 2, config: {} },
        { id: "second", agentId: 3, config: {} },
      ],
      edges: [
        { source: "start", target: "first", condition: { operator: "always" } },
        { source: "start", target: "second", condition: { operator: "always" } },
      ],
    });
    expect(evaluateGraph(graph, "start", {})).toMatchObject({
      kind: "dispatch",
      node: { id: "first" },
    });
  });

  it("evaluates nested structured predicates without executing code", () => {
    expect(
      predicateMatches(
        { operator: "in", path: ["review", "verdict"], value: ["pass", "waive"] },
        { review: { verdict: "pass" } },
      ),
    ).toBe(true);
    expect(
      predicateMatches(
        { operator: "exists", path: ["review", "reason"], value: false },
        { review: { verdict: "pass" } },
      ),
    ).toBe(true);
  });

  it("rejects malformed graph contracts and unmatched output", () => {
    expect(() =>
      parseWorkflowGraph({
        nodes: [{ id: "only", agentId: 1, config: {} }],
        edges: [],
      }),
    ).toThrow(/exactly one entry node/);
    expect(() =>
      parseWorkflowGraph({
        nodes: [{ id: "only", agentId: 1, config: { entry: true, fanOut: { over: "openTickets", maxConcurrency: 0 } } }],
        edges: [],
      }),
    ).toThrow(/maxConcurrency/);

    const graph = parseWorkflowGraph(graphValue);
    expect(() => evaluateGraph(graph, "test", { verdict: "wat" })).toThrow(
      WorkflowGraphError,
    );
  });
});
