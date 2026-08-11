import { describe, expect, it } from "vitest";
import { parseGraph } from "@/lib/control-plane/validate";
import {
  canonicalWorkflowGraphJson,
  parseWorkflowGraph,
  validateWorkflowGraph,
  workflowEntryNodeId,
  type WorkflowGraph,
} from "@/lib/workflow/graph-contract";
import { cycleReturnEdgeIndexes } from "@/lib/workflow/cycle-routes";

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
    expect(parseWorkflowGraph(rejectionLoop)).toBe(rejectionLoop);
    expect(workflowEntryNodeId(rejectionLoop)).toBe("implement");
    expect(rejectionLoop.nodes[0]!.config.futureEngineField).toEqual({ preserve: ["exactly"] });
  });

  it("preserves unknown future fields inside known configuration objects", () => {
    const graph = structuredClone(rejectionLoop);
    graph.nodes[0]!.config.fanOut = {
      over: "openTickets",
      maxConcurrency: 3,
      futureFanOutField: { keep: true },
    };
    graph.nodes[0]!.config.questionEscalation = {
      target: "human-via-channel",
      futureEscalationField: ["keep"],
    };
    graph.nodes[0]!.config.approvalGates = {
      pauseBefore: false,
      pauseAfter: true,
      futureApprovalField: "keep",
    };

    expect(parseWorkflowGraph(graph)).toBe(graph);
    expect(graph.nodes[0]!.config.fanOut!.futureFanOutField).toEqual({ keep: true });
    expect(graph.nodes[0]!.config.questionEscalation!.futureEscalationField).toEqual(["keep"]);
    expect(graph.nodes[0]!.config.approvalGates!.futureApprovalField).toBe("keep");
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

  it.each([
    ["leading node whitespace", { nodes: [{ ...rejectionLoop.nodes[0], id: " implement " }, rejectionLoop.nodes[1]], edges: rejectionLoop.edges }],
    ["non-normalized node Unicode", { nodes: [{ ...rejectionLoop.nodes[0], id: "impleme\u0301nt" }, rejectionLoop.nodes[1]], edges: rejectionLoop.edges }],
    ["edge ID whitespace", { ...rejectionLoop, edges: [{ ...rejectionLoop.edges[0], id: " transition " }] }],
    ["endpoint whitespace", { ...rejectionLoop, edges: [{ ...rejectionLoop.edges[0], source: " implement" }] }],
    ["raw endpoint mismatch", { ...rejectionLoop, edges: [{ ...rejectionLoop.edges[0], source: "Implement" }] }],
  ])("rejects noncanonical graph identity: %s", (_name, graph) => {
    expect(() => parseWorkflowGraph(graph)).toThrow();
  });

  it.each([
    ["entry type", { entry: "yes" }],
    ["channel binding type", { channelBinding: [] }],
    ["fan-out type", { fanOut: [] }],
    ["fan-out enum", { fanOut: { over: "closedTickets", maxConcurrency: 2 } }],
    ["fan-out concurrency type", { fanOut: { over: "openTickets", maxConcurrency: "2" } }],
    ["plan mode enum", { planMode: "telepathy" }],
    ["question answering type", { may_answer_questions: "sometimes" }],
    ["escalation type", { questionEscalation: [] }],
    ["escalation enum", { questionEscalation: { target: "nowhere" } }],
    ["missing escalation agent", { questionEscalation: { target: "agent" } }],
    ["escalation agent type", { questionEscalation: { target: "agent", agentId: [] } }],
    ["approval gate type", { approvalGates: [] }],
    ["pause-before type", { approvalGates: { pauseBefore: "yes" } }],
    ["pause-after type", { approvalGates: { pauseAfter: 1 } }],
  ])("rejects malformed documented node config: %s", (_name, invalidConfig) => {
    const graph = structuredClone(rejectionLoop);
    Object.assign(graph.nodes[0]!.config, invalidConfig);
    expect(() => parseWorkflowGraph(graph)).toThrow();
  });

  it("detects the closing return edge in an arbitrary three-node cycle", () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "A", agentId: "1", config: { entry: true } },
        { id: "B", agentId: "2", config: {} },
        { id: "C", agentId: "3", config: {} },
      ],
      edges: [
        { source: "A", target: "B", condition: { operator: "always" } },
        { source: "B", target: "C", condition: { operator: "always" } },
        { source: "C", target: "A", condition: { operator: "equals", path: ["verdict"], value: "rejected" } },
      ],
    };

    expect([...cycleReturnEdgeIndexes(graph)]).toEqual([2]);
  });
});
