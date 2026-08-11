import type { WorkflowEdge, WorkflowGraph } from "@/lib/workflow/graph-contract";

function hasPath(
  edges: WorkflowEdge[],
  source: string,
  target: string,
  excludedEdgeIndex: number,
): boolean {
  const pending = [source];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const nodeId = pending.shift()!;
    if (nodeId === target) return true;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    edges.forEach((edge, index) => {
      if (index !== excludedEdgeIndex && edge.source === nodeId && !visited.has(edge.target)) {
        pending.push(edge.target);
      }
    });
  }

  return false;
}

export function cycleReturnEdgeIndexes(graph: WorkflowGraph): ReadonlySet<number> {
  const nodeOrder = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const returnEdges = new Set<number>();

  graph.edges.forEach((edge, index) => {
    const sourceIndex = nodeOrder.get(edge.source);
    const targetIndex = nodeOrder.get(edge.target);
    if (
      sourceIndex !== undefined &&
      targetIndex !== undefined &&
      targetIndex <= sourceIndex &&
      hasPath(graph.edges, edge.target, edge.source, index)
    ) {
      returnEdges.add(index);
    }
  });

  return returnEdges;
}
