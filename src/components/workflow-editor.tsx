"use client";

import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useStore,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentDTO, WorkflowDTO } from "@/lib/control-plane/types";
import type {
  EdgePredicate,
  JsonObject,
  JsonValue,
  PlanMode,
  PredicateOperator,
  EscalationTarget,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from "@/lib/workflow/graph-contract";
import { cycleReturnEdgeIndexes } from "@/lib/workflow/cycle-routes";

type CanvasPosition = { x: number; y: number };
type Notice = { tone: "success" | "error" | "neutral"; text: string } | null;
type NodeCardData = { label: string; agent: string; detail: string; entry: boolean };

const inputClass = "w-full rounded-xl border border-[--border-strong] bg-[--background]/55 px-3 py-2 text-sm text-[--foreground] transition focus:border-[--accent] focus:outline-none";
const labelClass = "grid gap-1.5 text-xs font-medium text-[--foreground-muted]";
const buttonClass = "rounded-full border border-[--border-strong] px-3 py-2 text-sm text-[--foreground] transition hover:border-[color-mix(in_srgb,var(--accent)_45%,var(--border-strong))] hover:bg-[--surface-hover] disabled:cursor-not-allowed disabled:opacity-40";
const readableFitViewOptions = { padding: 0.12, minZoom: 0.75, maxZoom: 1.2 };
const retryableSaveFailure = "Save failed. Local edits remain in this editor, and retrying is safe.";
const connectionTargetPixels = 46;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyGraph(): WorkflowGraph {
  return { nodes: [], edges: [], builderMetadata: { positions: {} } };
}

function initialGraph(agentId?: string): WorkflowGraph {
  if (!agentId) return emptyGraph();
  return {
    nodes: [{ id: "start", agentId, config: { entry: true } }],
    edges: [],
    builderMetadata: { positions: { start: { x: 80, y: 100 } } },
  };
}

function graphFromWorkflow(workflow: WorkflowDTO): WorkflowGraph {
  return workflow.graph as WorkflowGraph;
}

function readPositions(graph: WorkflowGraph): Record<string, CanvasPosition> {
  const metadata = graph.builderMetadata;
  if (!isObject(metadata) || !isObject(metadata.positions)) return {};
  return Object.fromEntries(
    Object.entries(metadata.positions).filter(
      (entry): entry is [string, CanvasPosition] =>
        isObject(entry[1]) && typeof entry[1].x === "number" && typeof entry[1].y === "number",
    ),
  );
}

function withPositions(graph: WorkflowGraph, positions: Record<string, CanvasPosition>): WorkflowGraph {
  const metadata = isObject(graph.builderMetadata) ? graph.builderMetadata : {};
  return { ...graph, builderMetadata: { ...metadata, positions } as JsonObject };
}

function nextNodeId(nodes: WorkflowNode[]): string {
  let number = nodes.length + 1;
  while (nodes.some((node) => node.id === `node-${number}`)) number += 1;
  return `node-${number}`;
}

function conditionLabel(condition: EdgePredicate): string {
  if (condition.operator === "always") return "always";
  const path = condition.path?.join(".") ?? "output";
  if (condition.operator === "exists") return `${path} exists = ${String(condition.value)}`;
  const symbol = condition.operator === "equals" ? "==" : condition.operator === "notEquals" ? "!=" : "in";
  return `${path} ${symbol} ${JSON.stringify(condition.value)}`;
}

function nodeDetail(node: WorkflowNode): string {
  const details: string[] = [];
  if (node.config.fanOut) details.push(`fan-out ${node.config.fanOut.maxConcurrency}`);
  if (typeof node.config.planMode === "string") details.push(node.config.planMode);
  return details.join(" · ") || "single activation";
}

function WorkflowNodeCard({ data, selected }: NodeProps) {
  const card = data as NodeCardData;
  return (
    <div className={`min-w-44 rounded-2xl border bg-[#0b111f]/95 px-4 py-3 shadow-2xl transition ${selected ? "border-[--accent] shadow-[0_0_26px_-10px_rgba(var(--glow),0.9)]" : "border-[--border-strong]"}`}>
      <ConnectionHandle type="target" position={Position.Left} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-[--foreground]">{card.label}</p>
          <p className="mt-0.5 truncate text-sm text-[--foreground-muted]">{card.agent}</p>
        </div>
        {card.entry && <span className="rounded-full bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-[--accent]">Entry</span>}
      </div>
      <p className="mt-3 border-t border-[--border] pt-2 text-xs uppercase tracking-[0.12em] text-[--foreground-subtle]">{card.detail}</p>
      <ConnectionHandle type="source" position={Position.Right} />
      <ConnectionHandle id="loop-target" type="target" position={Position.Bottom} left="25%" />
      <ConnectionHandle id="loop-source" type="source" position={Position.Bottom} left="75%" />
    </div>
  );
}

function ConnectionHandle({ type, position, id, left }: {
  type: "source" | "target";
  position: Position;
  id?: string;
  left?: string;
}) {
  const zoom = useStore((state) => state.transform[2]);
  const safeZoom = Math.max(zoom, 0.01);
  const hitSize = connectionTargetPixels / safeZoom;
  const dotSize = 12 / safeZoom;
  return (
    <Handle
      id={id}
      type={type}
      position={position}
      aria-label={type === "source" ? "Start connection" : "Complete connection"}
      className="!grid !place-items-center !border-0 !bg-transparent"
      style={{ width: hitSize, height: hitSize, ...(left ? { left } : {}) }}
    >
      <span
        aria-hidden="true"
        className={type === "source" ? "rounded-full bg-[--accent]" : "rounded-full bg-[#a78bfa]"}
        style={{ width: dotSize, height: dotSize, border: `${2 / safeZoom}px solid #0b111f` }}
      />
    </Handle>
  );
}

const nodeTypes = { workflow: WorkflowNodeCard };

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

function errorMessage(body: unknown, fallback: string): string {
  if (isObject(body) && isObject(body.error) && typeof body.error.message === "string") return body.error.message;
  return fallback;
}

export function WorkflowEditor() {
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDTO[]>([]);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [name, setName] = useState("Untitled workflow");
  const [description, setDescription] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [graph, setGraph] = useState<WorkflowGraph>(emptyGraph);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeIndex, setSelectedEdgeIndex] = useState<number | null>(null);
  const [nodeIdText, setNodeIdText] = useState("");
  const [pathText, setPathText] = useState("");
  const [valueText, setValueText] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>({ tone: "neutral", text: "Loading workflows…" });
  const [saving, setSaving] = useState(false);

  const selectWorkflow = useCallback((workflow: WorkflowDTO) => {
    const nextGraph = graphFromWorkflow(workflow);
    setWorkflowId(workflow.id);
    setName(workflow.name);
    setDescription(workflow.description);
    setUpdatedAt(workflow.updatedAt);
    setGraph(nextGraph);
    setSelectedNodeId(nextGraph.nodes[0]?.id ?? null);
    setNodeIdText(nextGraph.nodes[0]?.id ?? "");
    setSelectedEdgeIndex(null);
    setPathText("");
    setValueText("");
    setFieldError(null);
    setNotice(null);
  }, []);

  const resetNewWorkflow = useCallback((availableAgents: AgentDTO[]) => {
    const nextGraph = initialGraph(availableAgents[0]?.id);
    setWorkflowId(null);
    setName("Untitled workflow");
    setDescription("");
    setUpdatedAt(null);
    setGraph(nextGraph);
    setSelectedNodeId(nextGraph.nodes[0]?.id ?? null);
    setNodeIdText(nextGraph.nodes[0]?.id ?? "");
    setSelectedEdgeIndex(null);
    setPathText("");
    setValueText("");
    setFieldError(null);
    setNotice(availableAgents.length ? null : { tone: "error", text: "Create an agent before adding workflow nodes." });
  }, []);

  const loadAll = useCallback(async (preferredId?: string | null) => {
    const [agentsResponse, workflowsResponse] = await Promise.all([
      fetch("/api/agents", { cache: "no-store" }),
      fetch("/api/workflows", { cache: "no-store" }),
    ]);
    const agentsBody = await readJson(agentsResponse);
    const workflowsBody = await readJson(workflowsResponse);
    if (!agentsResponse.ok || !workflowsResponse.ok || !Array.isArray(agentsBody) || !Array.isArray(workflowsBody)) throw new Error("Could not load workflow data.");
    const nextAgents = agentsBody as AgentDTO[];
    const nextWorkflows = workflowsBody as WorkflowDTO[];
    setAgents(nextAgents);
    setWorkflows(nextWorkflows);
    const preferred = nextWorkflows.find((workflow) => workflow.id === preferredId) ?? nextWorkflows[0];
    if (preferred) selectWorkflow(preferred);
    else resetNewWorkflow(nextAgents);
  }, [resetNewWorkflow, selectWorkflow]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      loadAll().catch((error: unknown) => setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load workflow data." }));
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadAll]);

  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = selectedEdgeIndex === null ? null : graph.edges[selectedEdgeIndex] ?? null;

  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const positions = readPositions(graph);
  const flowNodes = graph.nodes.map((node, index) => ({
    id: node.id,
    type: "workflow",
    position: positions[node.id] ?? { x: 80 + (index % 3) * 250, y: 80 + Math.floor(index / 3) * 170 },
    data: { label: node.id, agent: agentNames.get(String(node.agentId)) ?? `Agent ${node.agentId}`, detail: nodeDetail(node), entry: node.config.entry === true },
    ariaLabel: `${node.id}, assigned to ${agentNames.get(String(node.agentId)) ?? `agent ${node.agentId}`}`,
    selected: node.id === selectedNodeId,
  }));
  const returnEdgeIndexes = cycleReturnEdgeIndexes(graph);
  const flowEdges = graph.edges.map((edge, index) => {
    const isLoopRoute = returnEdgeIndexes.has(index);
    return {
      id: `edge-${index}`,
      source: edge.source,
      target: edge.target,
      sourceHandle: isLoopRoute ? "loop-source" : undefined,
      targetHandle: isLoopRoute ? "loop-target" : undefined,
      label: conditionLabel(edge.condition),
      selected: index === selectedEdgeIndex,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, color: "#a3e635" },
      style: { stroke: index === selectedEdgeIndex ? "#bef264" : isLoopRoute ? "#a78bfa" : "#8caadc", strokeWidth: index === selectedEdgeIndex ? 2.5 : 1.7 },
      labelStyle: { fill: "#e8f0ff", fontSize: 13, fontFamily: "var(--font-geist-mono)" },
      labelBgStyle: { fill: "#0b111f", fillOpacity: 0.94 },
      labelBgPadding: [7, 4] as [number, number],
      labelBgBorderRadius: 5,
    };
  });

  const updateNode = (nodeId: string, mutator: (node: WorkflowNode) => WorkflowNode) => {
    setGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === nodeId ? mutator(node) : node) }));
  };

  const updateNodeConfig = (mutator: (config: WorkflowNode["config"]) => WorkflowNode["config"]) => {
    if (selectedNode) updateNode(selectedNode.id, (node) => ({ ...node, config: mutator(node.config) }));
  };

  const updateEdge = (index: number, mutator: (edge: WorkflowEdge) => WorkflowEdge) => {
    setGraph((current) => ({ ...current, edges: current.edges.map((edge, edgeIndex) => edgeIndex === index ? mutator(edge) : edge) }));
  };

  const addNode = () => {
    if (!agents[0]) return setNotice({ tone: "error", text: "Create an agent before adding a node." });
    const id = nextNodeId(graph.nodes);
    const position = { x: 80 + (graph.nodes.length % 3) * 250, y: 80 + Math.floor(graph.nodes.length / 3) * 170 };
    setGraph((current) => withPositions({ ...current, nodes: [...current.nodes, { id, agentId: agents[0]!.id, config: { entry: current.nodes.length === 0 } }] }, { ...readPositions(current), [id]: position }));
    setSelectedNodeId(id);
    setNodeIdText(id);
    setSelectedEdgeIndex(null);
    setFieldError(null);
  };

  const deleteNode = (nodeId: string) => {
    setGraph((current) => {
      const nextPositions = { ...readPositions(current) };
      delete nextPositions[nodeId];
      return withPositions({ ...current, nodes: current.nodes.filter((node) => node.id !== nodeId), edges: current.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId) }, nextPositions);
    });
    setSelectedNodeId(null);
    setNodeIdText("");
    setSelectedEdgeIndex(null);
    setFieldError(null);
  };

  const renameNode = () => {
    if (!selectedNode) return;
    const nextId = nodeIdText;
    if (!nextId.trim()) return setFieldError("Node ID cannot be empty.");
    if (nextId !== nextId.trim() || nextId !== nextId.normalize("NFC")) return setFieldError("Node ID must already be in canonical form.");
    if (graph.nodes.some((node) => node.id === nextId && node.id !== selectedNode.id)) return setFieldError("Node IDs must be unique.");
    const oldId = selectedNode.id;
    if (nextId === oldId) return;
    setGraph((current) => {
      const currentPositions = readPositions(current);
      const nextPositions = { ...currentPositions, [nextId]: currentPositions[oldId] ?? { x: 80, y: 80 } };
      delete nextPositions[oldId];
      return withPositions({
        ...current,
        nodes: current.nodes.map((node) => node.id === oldId ? { ...node, id: nextId } : node),
        edges: current.edges.map((edge) => ({ ...edge, source: edge.source === oldId ? nextId : edge.source, target: edge.target === oldId ? nextId : edge.target })),
      }, nextPositions);
    });
    setSelectedNodeId(nextId);
    setFieldError(null);
  };

  const onConnect = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    setGraph((current) => ({ ...current, edges: [...current.edges, { source: connection.source!, target: connection.target!, condition: { operator: "always" } }] }));
    setSelectedNodeId(null);
    setSelectedEdgeIndex(graph.edges.length);
    setPathText("");
    setValueText("");
    setFieldError(null);
  };

  const onNodesChange = (changes: NodeChange[]) => {
    for (const change of changes) {
      if (change.type === "remove") deleteNode(change.id);
      if (change.type === "position" && change.position) setGraph((current) => withPositions(current, { ...readPositions(current), [change.id]: change.position! }));
    }
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => Number(change.id.replace("edge-", ""))));
    if (!removed.size) return;
    setGraph((current) => ({ ...current, edges: current.edges.filter((_, index) => !removed.has(index)) }));
    setSelectedEdgeIndex(null);
    setPathText("");
    setValueText("");
    setFieldError(null);
  };

  const updateCondition = (operator: PredicateOperator, nextPath = pathText, nextValue = valueText) => {
    if (selectedEdgeIndex === null) return;
    if (operator === "always") {
      updateEdge(selectedEdgeIndex, (edge) => {
        const condition: EdgePredicate = { ...edge.condition, operator };
        delete condition.path;
        delete condition.value;
        return { ...edge, condition };
      });
      return setFieldError(null);
    }
    const path = nextPath.split(".").map((part) => part.trim()).filter(Boolean);
    if (!path.length) return setFieldError("Condition path is required.");
    let value: JsonValue;
    if (operator === "exists") value = nextValue === "false" ? false : true;
    else {
      try {
        value = JSON.parse(nextValue) as JsonValue;
      } catch {
        return setFieldError("Condition value must be valid JSON, such as \"rejected\".");
      }
      if (operator === "in" && !Array.isArray(value)) return setFieldError("The in operator requires a JSON array.");
    }
    updateEdge(selectedEdgeIndex, (edge) => ({ ...edge, condition: { ...edge.condition, operator, path, value } }));
    setFieldError(null);
  };

  const moveEdge = (direction: -1 | 1) => {
    if (selectedEdgeIndex === null) return;
    const source = graph.edges[selectedEdgeIndex]?.source;
    const siblingIndices = graph.edges.flatMap((edge, index) => edge.source === source ? [index] : []);
    const siblingPosition = siblingIndices.indexOf(selectedEdgeIndex);
    const target = siblingIndices[siblingPosition + direction];
    if (target === undefined) return;
    setGraph((current) => {
      const edges = [...current.edges];
      [edges[selectedEdgeIndex], edges[target]] = [edges[target]!, edges[selectedEdgeIndex]!];
      return { ...current, edges };
    });
    setSelectedEdgeIndex(target);
  };

  const save = async () => {
    if (fieldError) return setNotice({ tone: "error", text: fieldError });
    setSaving(true);
    setNotice({ tone: "neutral", text: "Saving authoritative graph…" });
    const body = workflowId ? { name, description, graph, expectedUpdatedAt: updatedAt } : { name, description, graph, isTemplate: false };
    try {
      const response = await fetch(workflowId ? `/api/workflows/${workflowId}` : "/api/workflows", { method: workflowId ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const responseBody = await readJson(response);
      if (response.status === 409) return setNotice({ tone: "error", text: "Save conflict: this workflow changed elsewhere. Reload its server copy before editing again." });
      if (!response.ok || !isObject(responseBody)) {
        const detail = response.status < 500 ? errorMessage(responseBody, "") : "";
        return setNotice({ tone: "error", text: detail ? `${retryableSaveFailure} ${detail}` : retryableSaveFailure });
      }
      const saved = responseBody as unknown as WorkflowDTO;
      setWorkflows((current) => [...current.filter((workflow) => workflow.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
      selectWorkflow(saved);
      setNotice({ tone: "success", text: "Saved to PostgreSQL. Reload will read this exact graph." });
    } catch {
      setNotice({ tone: "error", text: retryableSaveFailure });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="min-w-0">
      <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <span className="eyebrow">Workflow control plane</span>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-[--foreground] sm:text-4xl">Shape the route, not the judgment.</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[--foreground-muted]">Connect agents with structured transitions. Cycles are allowed; the first matching outgoing edge wins.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={buttonClass} onClick={() => loadAll(workflowId).catch(() => setNotice({ tone: "error", text: "Reload failed." }))}>Reload</button>
          <button type="button" onClick={save} disabled={saving} className="rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-[#071006] transition hover:bg-[var(--accent-hover)] disabled:opacity-50">{saving ? "Saving…" : "Save workflow"}</button>
        </div>
      </div>

      {notice && <NoticeBanner notice={notice} />}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[210px_minmax(0,1fr)_300px]">
        <aside className="glass min-w-0 rounded-3xl p-3">
          <div className="mb-3 flex items-center justify-between gap-2 px-1">
            <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-[--foreground-muted]">Workflows</h2>
            <button type="button" onClick={() => resetNewWorkflow(agents)} className="rounded-full border border-[--border-strong] px-2.5 py-1 text-xs text-[--accent] hover:bg-[--surface-hover]">New</button>
          </div>
          <div className="flex max-h-48 gap-2 overflow-auto pb-1 lg:max-h-[620px] lg:flex-col lg:pb-0">
            {workflows.map((workflow) => (
              <button type="button" key={workflow.id} onClick={() => selectWorkflow(workflow)} className={`min-w-40 rounded-2xl border p-3 text-left transition lg:min-w-0 ${workflow.id === workflowId ? "border-[color-mix(in_srgb,var(--accent)_42%,var(--border-strong))] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]" : "border-transparent hover:border-[--border] hover:bg-[--surface-hover]"}`}>
                <span className="block truncate text-sm font-medium text-[--foreground]">{workflow.name}</span>
                <span className="mt-1 block text-xs text-[--foreground-subtle]">{(workflow.graph.nodes as unknown[] | undefined)?.length ?? 0} nodes</span>
              </button>
            ))}
            {!workflows.length && <p className="px-2 py-4 text-xs leading-5 text-[--foreground-subtle]">No saved workflows yet.</p>}
          </div>
        </aside>

        <div className="min-w-0 space-y-4">
          <div className="glass grid gap-3 rounded-3xl p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-end">
            <label className={labelClass}>Workflow name<input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label className={labelClass}>Description<input className={inputClass} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
            <button type="button" className={buttonClass} onClick={addNode} disabled={!agents.length}>Add node</button>
          </div>
          <div className="glass h-[460px] min-w-0 overflow-hidden rounded-3xl border border-[--border] sm:h-[620px]" aria-label="Workflow canvas">
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_event, node) => { setSelectedNodeId(node.id); setNodeIdText(node.id); setSelectedEdgeIndex(null); setFieldError(null); }}
              onEdgeClick={(_event, edge) => {
                const index = Number(edge.id.replace("edge-", ""));
                const condition = graph.edges[index]?.condition;
                setSelectedEdgeIndex(index);
                setSelectedNodeId(null);
                setPathText(condition?.path?.join(".") ?? "");
                setValueText(condition?.value === undefined ? "" : JSON.stringify(condition.value));
                setFieldError(null);
              }}
              onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeIndex(null); setFieldError(null); }}
              fitView
              fitViewOptions={readableFitViewOptions}
              minZoom={0.25}
              maxZoom={1.8}
              deleteKeyCode={["Backspace", "Delete"]}
              defaultEdgeOptions={{ type: "smoothstep" }}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="rgba(140,170,220,0.18)" gap={22} size={1} />
              <Controls position="bottom-left" showInteractive={false} fitViewOptions={readableFitViewOptions} />
              <MiniMap pannable zoomable position="bottom-right" nodeColor={(node) => node.data.entry ? "#a3e635" : "#8caadc"} maskColor="rgba(4,6,12,0.78)" />
            </ReactFlow>
          </div>
        </div>

        <aside className="glass min-w-0 self-start rounded-3xl p-4 lg:max-h-[700px] lg:overflow-y-auto">
          {selectedNode ? (
            <NodePanel
              agents={agents}
              graph={graph}
              selectedNode={selectedNode}
              nodeIdText={nodeIdText}
              setNodeIdText={setNodeIdText}
              renameNode={renameNode}
              deleteNode={deleteNode}
              updateNode={updateNode}
              updateNodeConfig={updateNodeConfig}
              setGraph={setGraph}
            />
          ) : selectedEdge && selectedEdgeIndex !== null ? (
            <EdgePanel
              graph={graph}
              selectedEdge={selectedEdge}
              selectedEdgeIndex={selectedEdgeIndex}
              pathText={pathText}
              valueText={valueText}
              setPathText={setPathText}
              setValueText={setValueText}
              updateEdge={updateEdge}
              updateCondition={updateCondition}
              moveEdge={moveEdge}
              deleteEdge={() => onEdgesChange([{ id: `edge-${selectedEdgeIndex}`, type: "remove" }])}
            />
          ) : (
            <div className="grid min-h-52 place-items-center text-center">
              <div>
                <p className="text-sm font-medium text-[--foreground]">Select a node or edge</p>
                <p className="mt-2 text-xs leading-5 text-[--foreground-subtle]">Drag from a green node handle to a purple handle to create a directed transition, including a loop back.</p>
              </div>
            </div>
          )}
          {fieldError && <p role="alert" className="mt-4 rounded-xl bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] p-3 text-xs text-[--danger]">{fieldError}</p>}
        </aside>
      </div>
    </section>
  );
}

function NodePanel({ agents, graph, selectedNode, nodeIdText, setNodeIdText, renameNode, deleteNode, updateNode, updateNodeConfig, setGraph }: {
  agents: AgentDTO[];
  graph: WorkflowGraph;
  selectedNode: WorkflowNode;
  nodeIdText: string;
  setNodeIdText: (value: string) => void;
  renameNode: () => void;
  deleteNode: (id: string) => void;
  updateNode: (id: string, mutator: (node: WorkflowNode) => WorkflowNode) => void;
  updateNodeConfig: (mutator: (config: WorkflowNode["config"]) => WorkflowNode["config"]) => void;
  setGraph: React.Dispatch<React.SetStateAction<WorkflowGraph>>;
}) {
  const escalation = (
    isObject(selectedNode.config.questionEscalation) ? selectedNode.config.questionEscalation : {}
  ) as Partial<NonNullable<WorkflowNode["config"]["questionEscalation"]>> & JsonObject;
  const approvals = isObject(selectedNode.config.approvalGates) ? selectedNode.config.approvalGates : {};
  return (
    <div className="grid gap-5">
      <div className="flex items-center justify-between gap-3">
        <div><p className="text-[10px] uppercase tracking-[0.18em] text-[--accent]">Node config</p><h2 className="mt-1 truncate text-lg font-semibold text-[--foreground]">{selectedNode.id}</h2></div>
        <button type="button" className="text-xs text-[--danger] hover:underline" onClick={() => deleteNode(selectedNode.id)}>Delete</button>
      </div>
      <label className={labelClass}>Node ID<input className={inputClass} value={nodeIdText} onChange={(event) => setNodeIdText(event.target.value)} onBlur={renameNode} /></label>
      <label className={labelClass}>Agent<select className={inputClass} value={String(selectedNode.agentId)} onChange={(event) => updateNode(selectedNode.id, (node) => ({ ...node, agentId: event.target.value }))}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.model}</option>)}</select></label>
      <fieldset className="grid gap-3 border-t border-[--border] pt-4">
        <legend className="sr-only">Entry settings</legend>
        <CheckField label="Entry node" checked={selectedNode.config.entry === true} onChange={(checked) => setGraph((current) => ({ ...current, nodes: current.nodes.map((node) => {
          if (node.id === selectedNode.id) return { ...node, config: { ...node.config, entry: checked } };
          return checked ? { ...node, config: { ...node.config, entry: false } } : node;
        }) }))} />
        <CheckField label="Receive inbound channel" detail="Uses the selected agent's configured channel binding." checked={selectedNode.config.channelBinding === true} onChange={(checked) => updateNodeConfig((config) => ({ ...config, channelBinding: checked }))} />
      </fieldset>
      <fieldset className="grid gap-3 border-t border-[--border] pt-4">
        <legend className="text-xs font-semibold uppercase tracking-[0.14em] text-[--foreground-muted]">Fan-out</legend>
        <CheckField label="Run over open tickets" checked={Boolean(selectedNode.config.fanOut)} onChange={(checked) => updateNodeConfig((config) => { const next = { ...config }; if (checked) next.fanOut = { over: "openTickets", maxConcurrency: 2 }; else delete next.fanOut; return next; })} />
        {selectedNode.config.fanOut && <label className={labelClass}>Max concurrent workers<input type="number" min="1" step="1" className={inputClass} value={selectedNode.config.fanOut.maxConcurrency} onChange={(event) => updateNodeConfig((config) => ({ ...config, fanOut: { ...config.fanOut!, over: "openTickets", maxConcurrency: Number(event.target.value) } }))} /></label>}
      </fieldset>
      <fieldset className="grid gap-3 border-t border-[--border] pt-4">
        <legend className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-[--foreground-muted]">Judgment<Tooltip text="Cheaper models benefit from required planning because the plan gives them a smaller, explicit decision path before acting." /></legend>
        <label className={labelClass}>Plan mode<select className={inputClass} value={typeof selectedNode.config.planMode === "string" ? selectedNode.config.planMode : "off"} onChange={(event) => updateNodeConfig((config) => ({ ...config, planMode: event.target.value as PlanMode }))}><option value="off">Off</option><option value="allowed">Allowed</option><option value="required">Required</option></select></label>
        <CheckField label="May answer questions" checked={selectedNode.config.may_answer_questions === true} onChange={(checked) => updateNodeConfig((config) => ({ ...config, may_answer_questions: checked }))} />
        <label className={labelClass}>Question escalation<select className={inputClass} value={typeof escalation.target === "string" ? escalation.target : "human-via-UI"} onChange={(event) => updateNodeConfig((config) => { const target = event.target.value as EscalationTarget; return { ...config, questionEscalation: { ...escalation, target, ...(target === "agent" && escalation.agentId === undefined ? { agentId: agents[0]?.id } : {}) } as NonNullable<WorkflowNode["config"]["questionEscalation"]> }; })}><option value="agent">Agent</option><option value="human-via-channel">Human via channel</option><option value="human-via-UI">Human via UI</option></select></label>
        {escalation.target === "agent" && <label className={labelClass}>Escalation agent<select className={inputClass} value={escalation.agentId === undefined ? agents[0]?.id ?? "" : String(escalation.agentId)} onChange={(event) => updateNodeConfig((config) => ({ ...config, questionEscalation: { ...escalation, target: "agent", agentId: event.target.value } as NonNullable<WorkflowNode["config"]["questionEscalation"]> }))}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>}
      </fieldset>
      <fieldset className="grid gap-3 border-t border-[--border] pt-4">
        <legend className="text-xs font-semibold uppercase tracking-[0.14em] text-[--foreground-muted]">Approval gates</legend>
        <CheckField label="Pause before node" checked={approvals.pauseBefore === true} onChange={(checked) => updateNodeConfig((config) => ({ ...config, approvalGates: { ...approvals, pauseBefore: checked } as JsonObject }))} />
        <CheckField label="Pause after node" checked={approvals.pauseAfter === true} onChange={(checked) => updateNodeConfig((config) => ({ ...config, approvalGates: { ...approvals, pauseAfter: checked } as JsonObject }))} />
      </fieldset>
      <p className="sr-only">{graph.nodes.length} nodes</p>
    </div>
  );
}

function EdgePanel({ graph, selectedEdge, selectedEdgeIndex, pathText, valueText, setPathText, setValueText, updateEdge, updateCondition, moveEdge, deleteEdge }: {
  graph: WorkflowGraph;
  selectedEdge: WorkflowEdge;
  selectedEdgeIndex: number;
  pathText: string;
  valueText: string;
  setPathText: (value: string) => void;
  setValueText: (value: string) => void;
  updateEdge: (index: number, mutator: (edge: WorkflowEdge) => WorkflowEdge) => void;
  updateCondition: (operator: PredicateOperator, path?: string, value?: string) => void;
  moveEdge: (direction: -1 | 1) => void;
  deleteEdge: () => void;
}) {
  return (
    <div className="grid gap-5">
      <div className="flex items-center justify-between gap-3"><div><p className="text-[10px] uppercase tracking-[0.18em] text-[#a78bfa]">Transition {selectedEdgeIndex + 1}</p><h2 className="mt-1 text-lg font-semibold text-[--foreground]">{selectedEdge.source} → {selectedEdge.target}</h2></div><button type="button" className="text-xs text-[--danger] hover:underline" onClick={deleteEdge}>Delete</button></div>
      <div className="grid grid-cols-2 gap-2"><button type="button" className={buttonClass} disabled={!graph.edges.slice(0, selectedEdgeIndex).some((edge) => edge.source === selectedEdge.source)} onClick={() => moveEdge(-1)}>Earlier</button><button type="button" className={buttonClass} disabled={!graph.edges.slice(selectedEdgeIndex + 1).some((edge) => edge.source === selectedEdge.source)} onClick={() => moveEdge(1)}>Later</button></div>
      <p className="text-xs leading-5 text-[--foreground-subtle]">Outgoing edges are evaluated in this order. The first match wins.</p>
      <label className={labelClass}>Source<select className={inputClass} value={selectedEdge.source} onChange={(event) => updateEdge(selectedEdgeIndex, (edge) => ({ ...edge, source: event.target.value }))}>{graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.id}</option>)}</select></label>
      <label className={labelClass}>Target<select className={inputClass} value={selectedEdge.target} onChange={(event) => updateEdge(selectedEdgeIndex, (edge) => ({ ...edge, target: event.target.value }))}>{graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.id}</option>)}</select></label>
      <label className={labelClass}>Operator<select className={inputClass} value={selectedEdge.condition.operator} onChange={(event) => { const operator = event.target.value as PredicateOperator; const path = pathText || "verdict"; const value = valueText || (operator === "exists" ? "true" : operator === "in" ? "[]" : "\"rejected\""); setPathText(path); setValueText(value); updateCondition(operator, path, value); }}><option value="always">Always</option><option value="equals">Equals</option><option value="notEquals">Not equals</option><option value="in">In list</option><option value="exists">Exists</option></select></label>
      {selectedEdge.condition.operator !== "always" && <label className={labelClass}>Output path<input className={inputClass} value={pathText} placeholder="verdict" onChange={(event) => { setPathText(event.target.value); updateCondition(selectedEdge.condition.operator, event.target.value, valueText); }} /></label>}
      {selectedEdge.condition.operator !== "always" && <label className={labelClass}>{selectedEdge.condition.operator === "exists" ? "Must exist" : "JSON value"}{selectedEdge.condition.operator === "exists" ? <select className={inputClass} value={valueText || "true"} onChange={(event) => { setValueText(event.target.value); updateCondition("exists", pathText, event.target.value); }}><option value="true">True</option><option value="false">False</option></select> : <input className={`${inputClass} font-mono`} value={valueText} placeholder={'"rejected"'} onChange={(event) => { setValueText(event.target.value); updateCondition(selectedEdge.condition.operator, pathText, event.target.value); }} />}</label>}
      <div className="rounded-xl border border-[--border] bg-[--background]/40 p-3 font-mono text-xs leading-5 text-[--foreground-muted]">{conditionLabel(selectedEdge.condition)}</div>
    </div>
  );
}

function CheckField({ label, detail, checked, onChange }: { label: string; detail?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex cursor-pointer items-start gap-3 text-sm text-[--foreground]"><input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-[--border-strong] accent-[--accent]" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span className="min-w-0"><span className="block">{label}</span>{detail && <span className="mt-0.5 block text-xs leading-5 text-[--foreground-subtle]">{detail}</span>}</span></label>;
}

function Tooltip({ text }: { text: string }) {
  return <span className="group relative inline-flex"><button type="button" aria-label="Plan mode guidance" title={text} className="grid h-5 w-5 place-items-center rounded-full border border-[--border-strong] text-[10px] normal-case tracking-normal text-[--foreground-muted]">?</button><span role="tooltip" className="pointer-events-none absolute left-0 top-7 z-20 hidden w-40 max-w-[calc(100vw-2rem)] rounded-xl border border-[--border-strong] bg-[#0b111f] p-3 text-left text-xs font-normal normal-case leading-5 tracking-normal text-[--foreground-muted] shadow-2xl group-hover:block group-focus-within:block">{text}</span></span>;
}

function NoticeBanner({ notice }: { notice: Exclude<Notice, null> }) {
  return <div role="status" className={`mb-4 rounded-2xl border px-4 py-3 text-sm ${notice.tone === "error" ? "border-[color-mix(in_srgb,var(--danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--danger)_9%,transparent)] text-[--danger]" : notice.tone === "success" ? "border-[color-mix(in_srgb,var(--success)_40%,transparent)] bg-[color-mix(in_srgb,var(--success)_8%,transparent)] text-[--success]" : "border-[--border] bg-[--surface] text-[--foreground-muted]"}`}>{notice.text}</div>;
}
