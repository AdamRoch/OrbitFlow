import { describe, expect, it } from "vitest";
import { parseGraph } from "@/lib/control-plane/validate";
import {
  canonicalWorkflowGraphJson,
  validateWorkflowGraph,
  type WorkflowGraph,
} from "@/lib/workflow/graph-contract";

const rejectionLoop: WorkflowGraph = {
  nodes: [
    {
      id: "implement",
      agentId: "1",
      config: {
        entry: true,
        channelBinding: true,
        fanOut: { over: "openTickets", maxConcurrency: 3 },
        planMode: "required",
        may_answer_questions: true,
        questionEscalation: { target: "human-via-channel" },
        approvalGates: { pauseBefore: false, pauseAfter: true },
        futureEngineField: { preserve: ["exactly"] },
      },
    },
    { id: "test", agentId: 2, config: { entry: false } },
  ],
  edges: [
    { source: "implement", target: "test", condition: { operator: "always" } },
    {
      source: "test",
      target: "implement",
      condition: { operator: "equals", path: ["verdict"], value: "rejected" },
      futureEdgeField: { preserve: true },
    },
  ],
  builderMetadata: {
    positions: { implement: { x: 20, y: 40 }, test: { x: 360, y: 40 } },
    futureBuilderField: "preserved",
  },
};

describe("workflow graph contract", () => {
  it("accepts cycles and returns the exact graph object without a translation model", () => {
    expect(() => validateWorkflowGraph(rejectionLoop)).not.toThrow();
    expect(parseGraph(rejectionLoop)).toBe(rejectionLoop);
    expect(rejectionLoop.nodes[0]!.config.futureEngineField).toEqual({ preserve: ["exactly"] });
  });

  it("produces byte-equivalent canonical JSON across object-key order", () => {
    const reordered = JSON.parse(JSON.stringify(rejectionLoop)) as WorkflowGraph;
    reordered.edges[1]!.condition = {
      value: "rejected",
      path: ["verdict"],
      operator: "equals",
    };
    expect(canonicalWorkflowGraphJson(reordered)).toBe(canonicalWorkflowGraphJson(rejectionLoop));
  });

  it.each([
    ["duplicate node identity", { ...rejectionLoop, nodes: [...rejectionLoop.nodes, rejectionLoop.nodes[0]] }],
    ["missing endpoint", { ...rejectionLoop, edges: [{ source: "test", target: "missing", condition: { operator: "always" } }] }],
    ["unsupported condition", { ...rejectionLoop, edges: [{ source: "test", target: "implement", condition: { operator: "javascript", source: "return true" } }] }],
    ["missing entry", { ...rejectionLoop, nodes: rejectionLoop.nodes.map((node) => ({ ...node, config: { ...node.config, entry: false } })) }],
    ["invalid fan-out", { ...rejectionLoop, nodes: [{ ...rejectionLoop.nodes[0], config: { ...rejectionLoop.nodes[0]!.config, fanOut: { maxConcurrency: 0 } } }, rejectionLoop.nodes[1]] }],
  ])("rejects %s", (_name, graph) => {
    expect(() => validateWorkflowGraph(graph)).toThrow();
  });

  it("rejects duplicate semantic transitions even when keys are reordered", () => {
    const duplicate = {
      ...rejectionLoop,
      edges: [
        rejectionLoop.edges[1],
        {
          source: "test",
          target: "implement",
          condition: { value: "rejected", operator: "equals", path: ["verdict"] },
        },
      ],
    };
    expect(() => validateWorkflowGraph(duplicate)).toThrow(/duplicate transition/);
  });
});
