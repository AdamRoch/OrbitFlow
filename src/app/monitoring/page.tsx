import type { Metadata } from "next";
import { MonitoringDashboard } from "@/components/monitoring-dashboard";
import { getControlPlaneRepository } from "@/lib/control-plane";
import type { MonitoringFilters, MonitoringSnapshot } from "@/lib/control-plane/types";

export const metadata: Metadata = { title: "Monitoring | OrbitFactory" };

const tabs = new Set(["board", "trail", "agents", "cost"]);

function optionalId(value: string | string[] | undefined): string | null {
  return typeof value === "string" && /^[1-9]\d*$/.test(value) ? value : null;
}

function emptySnapshot(filters: MonitoringFilters): MonitoringSnapshot {
  return {
    filters, readAt: new Date().toISOString(), runs: [], board: [], trail: [], agents: [], agentOptions: [], runCosts: [], agentCosts: [],
    runsTruncated: false, boardTruncated: false, trailTruncated: false, agentsTruncated: false,
    runCostsTruncated: false, agentCostsTruncated: false, agentOptionsTruncated: false,
  };
}

export default async function MonitoringPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const filters: MonitoringFilters = {
    runId: optionalId(params.runId),
    agentId: optionalId(params.agentId),
    messageType: typeof params.messageType === "string" ? params.messageType : null,
  };
  const tab = typeof params.tab === "string" && tabs.has(params.tab) ? params.tab as "board" | "trail" | "agents" | "cost" : "board";
  let snapshot: MonitoringSnapshot;
  let initialDegraded = false;
  try {
    snapshot = await getControlPlaneRepository().getMonitoringSnapshot(filters);
  } catch {
    // The client retry uses the same narrow snapshot route and leaves the
    // empty state visibly degraded instead of pretending stale UI is current.
    snapshot = emptySnapshot(filters);
    initialDegraded = true;
  }
  return <MonitoringDashboard initialSnapshot={snapshot} initialTab={tab} initialDegraded={initialDegraded} />;
}
