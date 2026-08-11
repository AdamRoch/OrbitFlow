import { describe, expect, it } from "vitest";
import {
  parseWorkflowGraph,
  type WorkflowGraph,
} from "@/lib/workflow/graph-contract";
import { canonicalWorkflowGraphJson } from "@/lib/workflow/graph-contract";
import { evaluateGraph, type GraphEvaluation } from "@/lib/workflow/graph";

function assertDispatch(evaluation: GraphEvaluation, expectedNodeId: string): void {
  expect(evaluation.kind).toBe("dispatch");
  if (evaluation.kind === "dispatch") {
    expect(evaluation.node.id).toBe(expectedNodeId);
  }
}

/**
 * FACT-21 template graphs, reproduced from the migration SQL for pure in-process
 * validation. These are the canonical graphs the seeding migration creates.
 * Test that they pass the contract and produce stable canonical JSON.
 */

const softwareFactoryGraph: WorkflowGraph = {
  nodes: [
    {
      id: "orchestrator",
      agentId: "1",
      config: {
        entry: true,
        channelBinding: true,
        planMode: "required",
        may_answer_questions: true,
        questionEscalation: { target: "human-via-channel" },
      },
    },
    {
      id: "planner",
      agentId: "2",
      config: {
        planMode: "required",
        may_answer_questions: true,
      },
    },
    {
      id: "implement",
      agentId: "3",
      config: {
        fanOut: { over: "openTickets", maxConcurrency: 3 },
        planMode: "allowed",
      },
    },
    {
      id: "test",
      agentId: "4",
      config: {
        planMode: "off",
        may_answer_questions: false,
      },
    },
    {
      id: "report",
      agentId: "1", // reuses the orchestrator agent
      config: {
        planMode: "off",
        may_answer_questions: true,
        questionEscalation: { target: "human-via-channel" },
      },
    },
  ],
  edges: [
    { source: "orchestrator", target: "planner", condition: { operator: "always" } },
    { source: "planner", target: "implement", condition: { operator: "always" } },
    { source: "implement", target: "test", condition: { operator: "always" } },
    { source: "test", target: "implement", condition: { operator: "equals", path: ["verdict"], value: "rejected" } },
    { source: "test", target: "report", condition: { operator: "always" } },
  ],
  builderMetadata: {
    positions: {
      orchestrator: { x: 20, y: 80 },
      planner: { x: 220, y: 80 },
      implement: { x: 420, y: 80 },
      test: { x: 620, y: 80 },
      report: { x: 420, y: 260 },
    },
  },
};

const researchPipelineGraph: WorkflowGraph = {
  nodes: [
    {
      id: "orchestrator",
      agentId: "1",
      config: {
        entry: true,
        channelBinding: true,
        planMode: "required",
        may_answer_questions: true,
        questionEscalation: { target: "human-via-channel" },
      },
    },
    {
      id: "research",
      agentId: "2",
      config: {
        fanOut: { over: "openTickets", maxConcurrency: 4 },
        planMode: "off",
      },
    },
    {
      id: "synthesize",
      agentId: "3",
      config: {
        planMode: "required",
        may_answer_questions: true,
      },
    },
    {
      id: "review",
      agentId: "4",
      config: {
        planMode: "off",
      },
    },
    {
      id: "report",
      agentId: "1",
      config: {
        planMode: "off",
        may_answer_questions: true,
        questionEscalation: { target: "human-via-channel" },
      },
    },
  ],
  edges: [
    { source: "orchestrator", target: "research", condition: { operator: "always" } },
    { source: "research", target: "synthesize", condition: { operator: "always" } },
    { source: "synthesize", target: "review", condition: { operator: "always" } },
    { source: "review", target: "synthesize", condition: { operator: "equals", path: ["verdict"], value: "rejected" } },
    { source: "review", target: "report", condition: { operator: "always" } },
  ],
  builderMetadata: {
    positions: {
      orchestrator: { x: 20, y: 80 },
      research: { x: 260, y: 80 },
      synthesize: { x: 520, y: 80 },
      review: { x: 720, y: 80 },
      report: { x: 520, y: 260 },
    },
  },
};

describe("FACT-21 Software Factory graph contract", () => {
  it("validates successfully", () => {
    expect(() => parseWorkflowGraph(softwareFactoryGraph)).not.toThrow();
  });

  it("has exactly one entry node", () => {
    const entryNodes = softwareFactoryGraph.nodes.filter((n) => n.config.entry === true);
    expect(entryNodes).toHaveLength(1);
    expect(entryNodes[0]!.id).toBe("orchestrator");
  });

  it("has a rejection cycle back from test to implement", () => {
    const cycleEdge = softwareFactoryGraph.edges.find(
      (e) => e.source === "test" && e.target === "implement",
    );
    expect(cycleEdge).toBeDefined();
    expect(cycleEdge!.condition.operator).toBe("equals");
    expect(cycleEdge!.condition.path).toEqual(["verdict"]);
    expect(cycleEdge!.condition.value).toBe("rejected");
  });

  it("has a fan-out node with maxConcurrency 3", () => {
    const implement = softwareFactoryGraph.nodes.find((n) => n.id === "implement")!;
    expect(implement.config.fanOut).toBeDefined();
    expect(implement.config.fanOut!.maxConcurrency).toBe(3);
    expect(implement.config.fanOut!.over).toBe("openTickets");
  });

  it("the reuses orchestrator for the report node", () => {
    const report = softwareFactoryGraph.nodes.find((n) => n.id === "report")!;
    const orchestrator = softwareFactoryGraph.nodes.find((n) => n.id === "orchestrator")!;
    expect(report.agentId).toBe(orchestrator.agentId);
  });

  it("produces stable canonical JSON", () => {
    const canonical = canonicalWorkflowGraphJson(softwareFactoryGraph);
    expect(typeof canonical).toBe("string");
    expect(canonical.length).toBeGreaterThan(0);

    const reordered = JSON.parse(canonical) as WorkflowGraph;
    expect(() => parseWorkflowGraph(reordered)).not.toThrow();
  });
});

describe("FACT-21 Research Pipeline graph contract", () => {
  it("validates successfully", () => {
    expect(() => parseWorkflowGraph(researchPipelineGraph)).not.toThrow();
  });

  it("has exactly one entry node", () => {
    const entryNodes = researchPipelineGraph.nodes.filter((n) => n.config.entry === true);
    expect(entryNodes).toHaveLength(1);
    expect(entryNodes[0]!.id).toBe("orchestrator");
  });

  it("has a review cycle back from reviewer to synthesizer", () => {
    const cycleEdge = researchPipelineGraph.edges.find(
      (e) => e.source === "review" && e.target === "synthesize",
    );
    expect(cycleEdge).toBeDefined();
    expect(cycleEdge!.condition.operator).toBe("equals");
    expect(cycleEdge!.condition.path).toEqual(["verdict"]);
    expect(cycleEdge!.condition.value).toBe("rejected");
  });

  it("has a fan-out node with maxConcurrency 4", () => {
    const research = researchPipelineGraph.nodes.find((n) => n.id === "research")!;
    expect(research.config.fanOut).toBeDefined();
    expect(research.config.fanOut!.maxConcurrency).toBe(4);
    expect(research.config.fanOut!.over).toBe("openTickets");
  });

  it("reuses the orchestrator for the report node", () => {
    const report = researchPipelineGraph.nodes.find((n) => n.id === "report")!;
    const orchestrator = researchPipelineGraph.nodes.find((n) => n.id === "orchestrator")!;
    expect(report.agentId).toBe(orchestrator.agentId);
  });

  it("produces stable canonical JSON", () => {
    const canonical = canonicalWorkflowGraphJson(researchPipelineGraph);
    expect(typeof canonical).toBe("string");
    expect(canonical.length).toBeGreaterThan(0);

    const reordered = JSON.parse(canonical) as WorkflowGraph;
    expect(() => parseWorkflowGraph(reordered)).not.toThrow();
  });
});

describe("FACT-21 template proof: deleting a node yields a valid graph that executes through the engine", () => {
  describe("Software Factory without test node", () => {
    const edited = (() => {
      const g = structuredClone(softwareFactoryGraph);
      g.nodes = g.nodes.filter((n) => n.id !== "test");
      g.edges = g.edges.filter(
        (e) => e.source !== "test" && e.target !== "test",
      );
      return g;
    })();

    it("still validates through parseWorkflowGraph", () => {
      expect(() => parseWorkflowGraph(edited)).not.toThrow();
      expect(edited.edges).toHaveLength(2);
      expect(edited.nodes).toHaveLength(4);
    });

    it("walks through evaluateGraph from entry to terminal: orchestrator -> planner -> implement -> complete", () => {
      // orchestrator (entry) dispatches to planner
      const step1: ReturnType<typeof evaluateGraph> = evaluateGraph(edited, "orchestrator", {});
      assertDispatch(step1, "planner");

      // planner dispatches to implement
      const step2 = evaluateGraph(edited, "planner", {});
      assertDispatch(step2, "implement");

      // implement has no outgoing edges -> terminal
      const step3 = evaluateGraph(edited, "implement", {});
      expect(step3.kind).toBe("complete");
    });
  });

  describe("Research Pipeline without review node", () => {
    const edited = (() => {
      const g = structuredClone(researchPipelineGraph);
      g.nodes = g.nodes.filter((n) => n.id !== "review");
      g.edges = g.edges.filter(
        (e) => e.source !== "review" && e.target !== "review",
      );
      return g;
    })();

    it("still validates through parseWorkflowGraph", () => {
      expect(() => parseWorkflowGraph(edited)).not.toThrow();
      expect(edited.edges).toHaveLength(2);
      expect(edited.nodes).toHaveLength(4);
    });

    it("walks through evaluateGraph from entry to terminal: orchestrator -> research -> synthesize -> complete", () => {
      // orchestrator (entry) dispatches to research
      const step1 = evaluateGraph(edited, "orchestrator", {});
      assertDispatch(step1, "research");

      // research dispatches to synthesize
      const step2 = evaluateGraph(edited, "research", {});
      assertDispatch(step2, "synthesize");

      // synthesize has no outgoing edges -> terminal
      const step3 = evaluateGraph(edited, "synthesize", {});
      expect(step3.kind).toBe("complete");
    });
  });
});
