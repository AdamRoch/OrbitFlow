"use client";

import { useCallback, useEffect, useState } from "react";
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

function queryFor(filters: MonitoringFilters): string {
  const query = new URLSearchParams();
  if (filters.runId) query.set("runId", filters.runId);
  if (filters.agentId) query.set("agentId", filters.agentId);
  if (filters.messageType) query.set("messageType", filters.messageType);
  return query.toString();
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

export function MonitoringDashboard({ initialSnapshot, initialTab }: {
  initialSnapshot: MonitoringSnapshot;
  initialTab: Tab;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [filters, setFilters] = useState<MonitoringFilters>(initialSnapshot.filters);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [loading, setLoading] = useState(false);
  const [degraded, setDegraded] = useState<string | null>(null);

  const refreshSnapshot = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/monitoring?${queryFor(filters)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`snapshot request returned ${response.status}`);
      setSnapshot(await response.json() as MonitoringSnapshot);
      setDegraded(null);
    } catch {
      // Keep the last authoritative snapshot visible. A stream wake-up has no
      // authority to replace it when the refresh itself is unavailable.
      setDegraded("Live refresh is unavailable. Showing the last authoritative snapshot.");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    const stream = new EventSource("/api/state-stream");
    const onOpen = () => void refreshSnapshot();
    const wake = (event: MessageEvent<string>) => {
      try {
        if (parseStateEvent(JSON.parse(event.data))) void refreshSnapshot();
      } catch {
        // A malformed wake-up is ignored. It never changes UI state directly.
      }
    };
    stream.addEventListener("open", onOpen);
    stream.addEventListener("state", wake as EventListener);
    return () => {
      stream.removeEventListener("open", onOpen);
      stream.removeEventListener("state", wake as EventListener);
      stream.close();
    };
  }, [refreshSnapshot]);

  const change = (partial: Partial<MonitoringFilters>) => {
    const next = { ...filters, ...partial };
    setFilters(next);
    const query = new URLSearchParams(queryFor(next));
    query.set("tab", tab);
    router.replace(`/monitoring?${query.toString()}`);
  };

  const chooseTab = (next: Tab) => {
    setTab(next);
    const query = new URLSearchParams(queryFor(filters));
    query.set("tab", next);
    router.replace(`/monitoring?${query.toString()}`);
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
          {loading ? "Refreshing…" : "Snapshot current"}
        </span>
      </div>

      {degraded && <p role="status" className="rounded-xl border border-amber-300/35 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">{degraded}</p>}

      <div role="tablist" aria-label="Monitoring views" className="grid min-w-0 grid-cols-2 gap-2 rounded-2xl glass p-2 sm:grid-cols-4">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
            onClick={() => chooseTab(item.id)}
            className={`min-w-0 rounded-xl px-3 py-2.5 text-left transition ${tab === item.id ? "bg-[--accent]/15 text-[--foreground] ring-1 ring-[--accent]/45" : "text-[--foreground-muted] hover:bg-[--surface-hover]"}`}>
            <span className="block text-sm font-medium">{item.label}</span>
            <span className="mt-0.5 block truncate text-[11px] text-[--foreground-subtle]">{item.description}</span>
          </button>
        ))}
      </div>

      <div className="grid min-w-0 gap-3 rounded-2xl glass p-3 sm:grid-cols-3">
        <label className="min-w-0 text-xs text-[--foreground-muted]">Run
          <select value={filters.runId ?? ""} onChange={(event) => change({ runId: event.target.value || null })} className="mt-1 block w-full rounded-lg border border-[--border-strong] bg-[--background]/60 px-2 py-2 text-sm text-[--foreground]">
            <option value="">All retained runs</option>
            {snapshot.runs.map((run) => <option key={run.id} value={run.id}>#{run.id} · {run.workflowName} · {run.status}</option>)}
          </select>
        </label>
        <label className="min-w-0 text-xs text-[--foreground-muted]">Agent
          <select value={filters.agentId ?? ""} onChange={(event) => change({ agentId: event.target.value || null })} className="mt-1 block w-full rounded-lg border border-[--border-strong] bg-[--background]/60 px-2 py-2 text-sm text-[--foreground]">
            <option value="">All agents</option>
            {snapshot.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <label className="min-w-0 text-xs text-[--foreground-muted]">Message type
          <select value={filters.messageType ?? ""} onChange={(event) => change({ messageType: event.target.value || null })} className="mt-1 block w-full rounded-lg border border-[--border-strong] bg-[--background]/60 px-2 py-2 text-sm text-[--foreground]">
            <option value="">All types</option>
            {MESSAGE_TYPES.map((type) => <option key={type} value={type}>{type.replace("_", " ")}</option>)}
          </select>
        </label>
      </div>

      {tab === "board" && <Board snapshot={snapshot} />}
      {tab === "trail" && <Trail snapshot={snapshot} />}
      {tab === "agents" && <Agents snapshot={snapshot} />}
      {tab === "cost" && <Cost snapshot={snapshot} />}
    </div>
  );
}

function Board({ snapshot }: { snapshot: MonitoringSnapshot }) {
  return <section aria-label="Board" className="ticket-panel rounded-[1.75rem] p-1.5"><div className="glass-core overflow-hidden p-0">
    {snapshot.board.length === 0 ? <Empty label="No durable tickets match this run." /> : <div className="divide-y divide-[--border]">
      {snapshot.board.map((ticket) => <article key={ticket.id} className="grid min-w-0 gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
        <div className="min-w-0"><p className="truncate text-sm font-medium text-[--foreground]">{ticket.identifier} · {ticket.title}</p><p className="mt-0.5 text-xs text-[--foreground-subtle]">Run {ticket.runId ?? "unassigned"} · updated {formatTime(ticket.updatedAt)}</p></div>
        <span className={`text-xs font-medium ${statusClass(ticket.status)}`}>{ticket.status.replace("_", " ")}</span>
        <span className="text-xs text-[--foreground-muted]">{ticket.assigneeName ?? "Unassigned"}</span>
      </article>)}
    </div>}
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
      <div className="mt-4 border-t border-[--border] pt-3"><p className="text-xs text-[--foreground-muted]">Task log</p>{agent.logs.length === 0 ? <p className="mt-1 text-xs text-[--foreground-subtle]">No messages attached to the current task.</p> : agent.logs.map((message) => <p key={message.id} className="mt-2 break-words text-xs text-[--foreground-muted]"><span className="text-[--accent]">{message.type}</span> · {message.handoffBrief ?? JSON.stringify(message.payload)}</p>)}</div>
    </article>)}
  </section>;
}

function Cost({ snapshot }: { snapshot: MonitoringSnapshot }) {
  return <section aria-label="Cost" className="space-y-4">
    <CostRunSection costs={snapshot.runCosts} />
    <CostAgentSection costs={snapshot.agentCosts} />
  </section>;
}

function CostRunSection({ costs }: { costs: MonitoringSnapshot["runCosts"] }) {
  return <div className="rounded-2xl glass p-4"><h2 className="text-sm font-medium text-[--foreground]">Per run</h2>{costs.length === 0 ? <Empty label="No cost events in this run scope." /> : <>
    <div className="mt-3 space-y-2 sm:hidden">{costs.map((cost) => <div key={cost.runId} className="rounded-xl border border-[--border] p-3 text-xs"><p className="font-medium text-[--foreground]">#{cost.runId} · {cost.workflowName}</p><div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[--foreground-muted]"><span>Tokens in <b className="font-mono text-[--foreground]">{cost.tokensIn}</b></span><span>Tokens out <b className="font-mono text-[--foreground]">{cost.tokensOut}</b></span><span className="col-span-2">Actual cost <b className="font-mono text-[--foreground]">{cost.totalCost}</b></span></div></div>)}</div>
    <div className="mt-3 hidden overflow-x-auto sm:block"><table className="w-full min-w-[34rem] text-left text-xs"><thead className="text-[--foreground-subtle]"><tr><th className="pb-2 font-medium">Run</th><th className="pb-2 font-medium">Tokens in</th><th className="pb-2 font-medium">Tokens out</th><th className="pb-2 text-right font-medium">Actual cost</th></tr></thead><tbody className="divide-y divide-[--border]">{costs.map((cost) => <tr key={cost.runId}><td className="py-2 text-[--foreground]">#{cost.runId} · {cost.workflowName}</td><td className="py-2 text-[--foreground-muted]">{cost.tokensIn}</td><td className="py-2 text-[--foreground-muted]">{cost.tokensOut}</td><td className="py-2 text-right font-mono text-[--foreground]">{cost.totalCost}</td></tr>)}</tbody></table></div>
  </>}</div>;
}

function CostAgentSection({ costs }: { costs: MonitoringSnapshot["agentCosts"] }) {
  return <div className="rounded-2xl glass p-4"><h2 className="text-sm font-medium text-[--foreground]">Per agent</h2>{costs.length === 0 ? <Empty label="No agent cost events in this scope." /> : <>
    <div className="mt-3 space-y-2 sm:hidden">{costs.map((cost) => <div key={`${cost.runId}:${cost.agentId}`} className="rounded-xl border border-[--border] p-3 text-xs"><p className="font-medium text-[--foreground]">#{cost.runId} · {cost.agentName}</p><div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[--foreground-muted]"><span>Tokens <b className="font-mono text-[--foreground]">{cost.totalTokens}</b></span><span>Actual <b className="font-mono text-[--foreground]">{cost.totalCost}</b></span><span>Ceiling <b className="font-mono text-[--foreground]">{cost.costLimit ?? "Not configured"}</b></span><span className={cost.costLimit === null ? "text-[--foreground-subtle]" : cost.overCostLimit ? "text-[--danger]" : "text-[--success]"}>{cost.costLimit === null ? "No comparison" : cost.overCostLimit ? "Over ceiling" : "Within ceiling"}</span></div></div>)}</div>
    <div className="mt-3 hidden overflow-x-auto sm:block"><table className="w-full min-w-[42rem] text-left text-xs"><thead className="text-[--foreground-subtle]"><tr><th className="pb-2 font-medium">Run / agent</th><th className="pb-2 font-medium">Tokens</th><th className="pb-2 text-right font-medium">Actual</th><th className="pb-2 text-right font-medium">Ceiling</th><th className="pb-2 text-right font-medium">Comparison</th></tr></thead><tbody className="divide-y divide-[--border]">{costs.map((cost) => <tr key={`${cost.runId}:${cost.agentId}`}><td className="py-2 text-[--foreground]">#{cost.runId} · {cost.agentName}</td><td className="py-2 text-[--foreground-muted]">{cost.totalTokens}</td><td className="py-2 text-right font-mono text-[--foreground]">{cost.totalCost}</td><td className="py-2 text-right font-mono text-[--foreground-muted]">{cost.costLimit ?? "Not configured"}</td><td className={`py-2 text-right font-medium ${cost.costLimit === null ? "text-[--foreground-subtle]" : cost.overCostLimit ? "text-[--danger]" : "text-[--success]"}`}>{cost.costLimit === null ? "—" : cost.overCostLimit ? "Over ceiling" : "Within ceiling"}</td></tr>)}</tbody></table></div>
  </>}</div>;
}

function Empty({ label }: { label: string }) {
  return <div className="px-4 py-12 text-center text-sm text-[--foreground-muted]">{label}</div>;
}
