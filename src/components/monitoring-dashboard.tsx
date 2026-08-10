"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SignalIcon } from "@/components/icons";
import type { MonitoringFilters, MonitoringSnapshot } from "@/lib/control-plane/types";
import { MESSAGE_TYPES } from "@/lib/message-types";
import { parseStateEvent } from "@/lib/state-events";

type Tab = "board" | "trail" | "agents" | "cost";

const TABS: { id: Tab; label: string; description: string }[] = [
  { id: "board", label: "Board", description: "Durable tickets by run" },
  { id: "trail", label: "Trail", description: "Messages, handoffs, and channel traffic" },
  { id: "agents", label: "Agents", description: "Task-backed agent state" },
  { id: "cost", label: "Cost", description: "Exact event aggregates" },
];
const SNAPSHOT_TIMEOUT_MS = 8_000;

function queryFor(filters: MonitoringFilters): string {
  const query = new URLSearchParams();
  if (filters.runId) query.set("runId", filters.runId);
  if (filters.agentId) query.set("agentId", filters.agentId);
  if (filters.messageType) query.set("messageType", filters.messageType);
  return query.toString();
}

function monitoringUrl(tab: Tab, filters: MonitoringFilters): string {
  const query = new URLSearchParams(queryFor(filters));
  query.set("tab", tab);
  return `/monitoring?${query.toString()}`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusClass(status: string): string {
  if (status === "working" || status === "running" || status === "done" || status === "completed") return "text-[--success]";
  if (status === "waiting-on-question" || status === "paused") return "text-amber-300";
  if (status === "failed" || status === "canceled") return "text-[--danger]";
  return "text-[--foreground-muted]";
}

export function MonitoringDashboard({ initialSnapshot, initialTab, initialDegraded = false }: {
  initialSnapshot: MonitoringSnapshot;
  initialTab: Tab;
  initialDegraded?: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [filters, setFilters] = useState<MonitoringFilters>(initialSnapshot.filters);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [loading, setLoading] = useState(false);
  const [refreshFailure, setRefreshFailure] = useState<string | null>(initialDegraded
    ? "Initial PostgreSQL snapshot is unavailable. Retrying when the live connection recovers."
    : null);
  const [streamConnected, setStreamConnected] = useState(false);
  const filtersRef = useRef(filters);
  const activeRequest = useRef<AbortController | null>(null);
  const refreshSequence = useRef(0);
  const queuedWake = useRef(false);
  const refreshSnapshotRef = useRef<(nextFilters: MonitoringFilters, supersede?: boolean) => void>(() => {});
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const degraded = refreshFailure ?? (streamConnected ? null : "Live listener is reconnecting. Showing the last authoritative snapshot.");

  useEffect(() => {
    refreshSnapshotRef.current = async (nextFilters: MonitoringFilters, supersede = false) => {
    if (activeRequest.current) {
      if (!supersede) {
        queuedWake.current = true;
        return;
      }
      activeRequest.current.abort();
    }
    const controller = new AbortController();
    activeRequest.current = controller;
    const sequence = ++refreshSequence.current;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, SNAPSHOT_TIMEOUT_MS);
    setLoading(true);
    try {
      const response = await fetch(`/api/monitoring?${queryFor(nextFilters)}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`snapshot request returned ${response.status}`);
      const nextSnapshot = await response.json() as MonitoringSnapshot;
      if (sequence !== refreshSequence.current || controller.signal.aborted) return;
      setSnapshot(nextSnapshot);
      setRefreshFailure(null);
    } catch {
      if (sequence !== refreshSequence.current || (controller.signal.aborted && !timedOut)) return;
      // Keep the last authoritative snapshot visible. A stream wake-up has no
      // authority to replace it when the refresh itself is unavailable.
      setRefreshFailure(timedOut
        ? "Authoritative snapshot timed out. Showing the last successful snapshot."
        : "Live refresh is unavailable. Showing the last successful snapshot.");
    } finally {
      window.clearTimeout(timeout);
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setLoading(false);
        if (queuedWake.current) {
          queuedWake.current = false;
          void refreshSnapshotRef.current(filtersRef.current);
        }
      }
    }
    };
  }, []);

  useEffect(() => {
    const stream = new EventSource("/api/state-stream");
    const onOpen = () => {
      setStreamConnected(true);
      void refreshSnapshotRef.current(filtersRef.current);
    };
    const wake = (event: MessageEvent<string>) => {
      try {
        if (parseStateEvent(JSON.parse(event.data))) void refreshSnapshotRef.current(filtersRef.current);
      } catch {
        // A malformed wake-up is ignored. It never changes UI state directly.
      }
    };
    const onError = () => {
      setStreamConnected(false);
    };
    stream.addEventListener("open", onOpen);
    stream.addEventListener("state", wake as EventListener);
    stream.addEventListener("error", onError);
    return () => {
      stream.removeEventListener("open", onOpen);
      stream.removeEventListener("state", wake as EventListener);
      stream.removeEventListener("error", onError);
      stream.close();
      activeRequest.current?.abort();
    };
  }, []);

  const applyFilters = (partial: Partial<MonitoringFilters>) => {
    const next = { ...filters, ...partial };
    filtersRef.current = next;
    setFilters(next);
    router.replace(monitoringUrl(tab, next));
    void refreshSnapshotRef.current(next, true);
  };

  const chooseTab = (next: Tab) => {
    setTab(next);
    router.replace(monitoringUrl(next, filters));
  };

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const key = event.key;
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(key)) return;
    event.preventDefault();
    const nextIndex = key === "Home" ? 0 : key === "End" ? TABS.length - 1
      : (index + (key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    const next = TABS[nextIndex]!;
    chooseTab(next.id);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <div className="space-y-5" aria-busy={loading}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="eyebrow"><SignalIcon className="h-3 w-3" /> Authoritative snapshots</span>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[--foreground] text-glow">Monitoring</h1>
          <p className="mt-1 max-w-2xl text-sm text-[--foreground-muted]">
            The state stream wakes a new PostgreSQL read. It is never the source of truth.
          </p>
        </div>
        <span className="text-xs text-[--foreground-subtle]" aria-live="polite">
          {loading ? "Refreshing…" : degraded ? "Degraded snapshot" : "Snapshot current"}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[--foreground-subtle]">
        <span>Last successful read: {formatTime(snapshot.readAt)}</span>
        <span>{streamConnected ? "Live listener connected" : "Live listener reconnecting"}</span>
      </div>

      {degraded && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300/35 bg-amber-300/10 px-3 py-2 text-sm text-amber-100"><span>{degraded}</span><button type="button" onClick={() => void refreshSnapshotRef.current(filtersRef.current, true)} className="rounded-lg border border-amber-200/40 px-2 py-1 text-xs font-medium hover:bg-amber-100/10">Retry snapshot</button></div>}

      <div role="tablist" aria-label="Monitoring views" className="grid min-w-0 grid-cols-2 gap-2 rounded-2xl glass p-2 sm:grid-cols-4">
        {TABS.map((item, index) => (
          <button key={item.id} ref={(node) => { tabRefs.current[index] = node; }} type="button" role="tab" id={`monitoring-tab-${item.id}`} aria-controls={`monitoring-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1}
            onClick={() => chooseTab(item.id)} onKeyDown={(event) => onTabKeyDown(event, index)}
            className={`min-w-0 rounded-xl border px-3 py-2.5 text-left transition ${tab === item.id ? "border-[--accent]/80 bg-[--accent]/20 text-[--foreground] shadow-[0_0_0_2px_rgba(var(--glow),0.18),0_0_24px_rgba(var(--glow),0.24)]" : "border-transparent text-[--foreground-muted] hover:bg-[--surface-hover]"}`}>
            <span className="flex items-center gap-1.5 text-sm font-medium">{item.label}{tab === item.id && <span className="rounded-full bg-[--accent] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[#04121a]">Current</span>}</span>
            <span className="mt-0.5 block truncate text-[11px] text-[--foreground-subtle]">{item.description}</span>
          </button>
        ))}
      </div>

      <div className="grid min-w-0 gap-3 rounded-2xl glass p-3 sm:grid-cols-3">
        <label className="min-w-0 text-xs text-[--foreground-muted]">Run
          <select value={filters.runId ?? ""} onChange={(event) => applyFilters({ runId: event.target.value || null })} className="mt-1 block w-full rounded-lg border border-[--border-strong] bg-[--background]/60 px-2 py-2 text-sm text-[--foreground]">
            <option value="">All retained runs</option>
            {snapshot.runs.map((run) => <option key={run.id} value={run.id}>#{run.id} · {run.workflowName} · {run.status}</option>)}
          </select>
        </label>
        <label className="min-w-0 text-xs text-[--foreground-muted]">Agent
          <select value={filters.agentId ?? ""} onChange={(event) => applyFilters({ agentId: event.target.value || null })} className="mt-1 block w-full rounded-lg border border-[--border-strong] bg-[--background]/60 px-2 py-2 text-sm text-[--foreground]">
            <option value="">All agents</option>
            {snapshot.agentOptions.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <label className="min-w-0 text-xs text-[--foreground-muted]">Message type
          <select value={filters.messageType ?? ""} onChange={(event) => applyFilters({ messageType: event.target.value || null })} className="mt-1 block w-full rounded-lg border border-[--border-strong] bg-[--background]/60 px-2 py-2 text-sm text-[--foreground]">
            <option value="">All types</option>
            {MESSAGE_TYPES.map((type) => <option key={type} value={type}>{type.replace("_", " ")}</option>)}
          </select>
        </label>
      </div>

      {snapshot.runsTruncated && <p className="text-xs text-[--foreground-subtle]">Run selector shows the newest 100 retained runs.</p>}
      {snapshot.agentOptionsTruncated && <p className="text-xs text-[--foreground-subtle]">Agent selector shows the first 200 selected-run participants.</p>}

      <div role="tabpanel" id={`monitoring-panel-${tab}`} aria-labelledby={`monitoring-tab-${tab}`} tabIndex={0}>
        {tab === "board" && <Board snapshot={snapshot} />}
        {tab === "trail" && <Trail snapshot={snapshot} />}
        {tab === "agents" && <Agents snapshot={snapshot} />}
        {tab === "cost" && <Cost snapshot={snapshot} />}
      </div>
    </div>
  );
}

function Board({ snapshot }: { snapshot: MonitoringSnapshot }) {
  return <section aria-label="Board" className="ticket-panel rounded-[1.75rem] p-1.5"><div className="glass-core overflow-hidden p-0">
    {snapshot.board.length === 0 ? <Empty label="No durable tickets match this run." /> : <div className="divide-y divide-[--border]">
      {snapshot.board.map((ticket) => <article key={ticket.id} className="grid min-w-0 gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
        <div className="min-w-0"><p className="break-words text-sm font-medium text-[--foreground] sm:truncate">{ticket.identifier} · {ticket.title}</p><p className="mt-0.5 text-xs text-[--foreground-subtle]">Run {ticket.runId ?? "unassigned"} · updated {formatTime(ticket.updatedAt)}</p></div>
        <span className={`text-xs font-medium ${statusClass(ticket.status)}`}>{ticket.status.replace("_", " ")}</span>
        <span className="text-xs text-[--foreground-muted]">{ticket.assigneeName ?? "Unassigned"}</span>
      </article>)}
    </div>}
    {snapshot.boardTruncated && <p className="border-t border-[--border] px-4 py-3 text-xs text-[--foreground-subtle]">Showing the first 200 matching tickets. Refine filters to keep the authoritative snapshot bounded.</p>}
  </div></section>;
}

function Trail({ snapshot }: { snapshot: MonitoringSnapshot }) {
  return <section aria-label="Trail" className="ticket-panel rounded-[1.75rem] p-1.5"><div className="glass-core overflow-hidden p-0">
    {snapshot.trail.length === 0 ? <Empty label="No durable messages match these filters." /> : <div className="divide-y divide-[--border]">
      {snapshot.trail.map((message) => <article key={message.id} className="min-w-0 px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs"><span className="font-medium text-[--accent]">{message.type.replace("_", " ")}</span><span className="truncate text-[--foreground-muted]">{message.sender} → {message.recipient}</span><span className="ml-auto text-[--foreground-subtle]">#{message.sequenceNumber}</span></div>
        {message.handoffBrief && <p className="mt-2 break-words text-sm text-[--foreground]">{message.handoffBrief}</p>}
        <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/20 p-2 text-[11px] leading-relaxed text-[--foreground-muted]">{JSON.stringify(message.payload)}</pre>
        <p className="mt-2 text-[11px] text-[--foreground-subtle]">Run {message.runId} · {formatTime(message.createdAt)}</p>
      </article>)}
    </div>}
    {snapshot.trailTruncated && <p className="border-t border-[--border] px-4 py-3 text-xs text-[--foreground-subtle]">Showing the newest 200 messages. Refine filters to keep the authoritative snapshot bounded.</p>}
  </div></section>;
}

function Agents({ snapshot }: { snapshot: MonitoringSnapshot }) {
  return <section aria-label="Agents" className="grid min-w-0 gap-3 sm:grid-cols-2">
    {snapshot.agents.length === 0 ? <div className="sm:col-span-2 glass rounded-2xl"><Empty label="No durable agents match this filter." /></div> : snapshot.agents.map((agent) => <article key={agent.id} className="min-w-0 rounded-2xl glass p-4">
      <div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate text-sm font-medium text-[--foreground]">{agent.name}</h2><p className="truncate text-xs text-[--foreground-subtle]">{agent.role}</p></div><span className={`shrink-0 text-xs font-medium ${statusClass(agent.status)}`}>{agent.status.replaceAll("-", " ")}</span></div>
      <p className="mt-4 text-xs text-[--foreground-muted]">Current task</p><p className="mt-1 min-h-5 break-words text-sm text-[--foreground]">{agent.currentTask ? `${agent.currentTask.identifier} · ${agent.currentTask.title}` : "No active assigned ticket"}</p>
      <div className="mt-4 border-t border-[--border] pt-3"><p className="text-xs text-[--foreground-muted]">Task log</p>{agent.logs.length === 0 ? <p className="mt-1 text-xs text-[--foreground-subtle]">No messages attached to the current task.</p> : agent.logs.map((message) => <p key={message.id} className="mt-2 break-words text-xs text-[--foreground-muted]"><span className="text-[--accent]">{message.type}</span> · {message.handoffBrief ?? JSON.stringify(message.payload)}</p>)}{agent.logsTruncated && <p className="mt-2 text-[11px] text-[--foreground-subtle]">Showing the latest three task messages.</p>}</div>
    </article>)}
    {snapshot.agentsTruncated && <p className="sm:col-span-2 text-xs text-[--foreground-subtle]">Showing the first 200 matching agents. Refine filters to keep the authoritative snapshot bounded.</p>}
  </section>;
}

function Cost({ snapshot }: { snapshot: MonitoringSnapshot }) {
  return <section aria-label="Cost" className="space-y-4">
    <CostRunSection costs={snapshot.runCosts} truncated={snapshot.runCostsTruncated} />
    <CostAgentSection costs={snapshot.agentCosts} truncated={snapshot.agentCostsTruncated} />
  </section>;
}

function CostRunSection({ costs, truncated }: { costs: MonitoringSnapshot["runCosts"]; truncated: boolean }) {
  return <div className="rounded-2xl glass p-4"><h2 className="text-sm font-medium text-[--foreground]">Per run <span className="font-normal text-[--foreground-subtle]">· tokens and exact USD</span></h2>{costs.length === 0 ? <Empty label="No cost events in this run scope." /> : <>
    <div className="mt-3 space-y-2 sm:hidden">{costs.map((cost) => <div key={cost.runId} className="rounded-xl border border-[--border] p-3 text-xs"><p className="font-medium text-[--foreground]">#{cost.runId} · {cost.workflowName}</p><div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[--foreground-muted]"><span>Tokens in (count) <b className="font-mono text-[--foreground]">{cost.tokensIn}</b></span><span>Tokens out (count) <b className="font-mono text-[--foreground]">{cost.tokensOut}</b></span><span className="col-span-2">Actual cost (USD) <b className="font-mono text-[--foreground]">{cost.totalCost}</b></span></div></div>)}</div>
    <div className="mt-3 hidden overflow-x-auto sm:block"><table className="w-full min-w-[34rem] text-left text-xs"><thead className="text-[--foreground-subtle]"><tr><th className="pb-2 font-medium">Run</th><th className="pb-2 font-medium">Tokens in (count)</th><th className="pb-2 font-medium">Tokens out (count)</th><th className="pb-2 text-right font-medium">Actual cost (USD)</th></tr></thead><tbody className="divide-y divide-[--border]">{costs.map((cost) => <tr key={cost.runId}><td className="py-2 text-[--foreground]">#{cost.runId} · {cost.workflowName}</td><td className="py-2 text-[--foreground-muted]">{cost.tokensIn}</td><td className="py-2 text-[--foreground-muted]">{cost.tokensOut}</td><td className="py-2 text-right font-mono text-[--foreground]">{cost.totalCost}</td></tr>)}</tbody></table></div>
  </>}{truncated && <p className="mt-3 text-xs text-[--foreground-subtle]">Showing the newest 100 run aggregates.</p>}</div>;
}

function CostAgentSection({ costs, truncated }: { costs: MonitoringSnapshot["agentCosts"]; truncated: boolean }) {
  return <div className="rounded-2xl glass p-4"><h2 className="text-sm font-medium text-[--foreground]">Per agent <span className="font-normal text-[--foreground-subtle]">· tokens and exact USD</span></h2>{costs.length === 0 ? <Empty label="No agent cost events in this scope." /> : <>
    <div className="mt-3 space-y-2 sm:hidden">{costs.map((cost) => <div key={`${cost.runId}:${cost.agentId}`} className="rounded-xl border border-[--border] p-3 text-xs"><p className="font-medium text-[--foreground]">#{cost.runId} · {cost.agentName}</p><div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[--foreground-muted]"><span>Tokens (count) <b className="font-mono text-[--foreground]">{cost.totalTokens}</b></span><span>Actual (USD) <b className="font-mono text-[--foreground]">{cost.totalCost}</b></span><span>Ceiling (USD) <b className="font-mono text-[--foreground]">{cost.costLimit ?? "Not configured"}</b></span><span className={cost.costLimit === null ? "text-[--foreground-subtle]" : cost.overCostLimit ? "text-[--danger]" : "text-[--success]"}>{cost.costLimit === null ? "No comparison" : cost.overCostLimit ? "Over ceiling" : "Within ceiling"}</span></div></div>)}</div>
    <div className="mt-3 hidden overflow-x-auto sm:block"><table className="w-full min-w-[42rem] text-left text-xs"><thead className="text-[--foreground-subtle]"><tr><th className="pb-2 font-medium">Run / agent</th><th className="pb-2 font-medium">Tokens (count)</th><th className="pb-2 text-right font-medium">Actual (USD)</th><th className="pb-2 text-right font-medium">Ceiling (USD)</th><th className="pb-2 text-right font-medium">Comparison</th></tr></thead><tbody className="divide-y divide-[--border]">{costs.map((cost) => <tr key={`${cost.runId}:${cost.agentId}`}><td className="py-2 text-[--foreground]">#{cost.runId} · {cost.agentName}</td><td className="py-2 text-[--foreground-muted]">{cost.totalTokens}</td><td className="py-2 text-right font-mono text-[--foreground]">{cost.totalCost}</td><td className="py-2 text-right font-mono text-[--foreground-muted]">{cost.costLimit ?? "Not configured"}</td><td className={`py-2 text-right font-medium ${cost.costLimit === null ? "text-[--foreground-subtle]" : cost.overCostLimit ? "text-[--danger]" : "text-[--success]"}`}>{cost.costLimit === null ? "—" : cost.overCostLimit ? "Over ceiling" : "Within ceiling"}</td></tr>)}</tbody></table></div>
  </>}{truncated && <p className="mt-3 text-xs text-[--foreground-subtle]">Showing the first 200 agent aggregates.</p>}</div>;
}

function Empty({ label }: { label: string }) {
  return <div className="px-4 py-12 text-center text-sm text-[--foreground-muted]">{label}</div>;
}
