import type {
  Agent,
  Run,
  RunDetail,
  ScheduleStatus,
  Settings,
  Workflow,
} from "../shared/types";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const writesJson =
    init?.method && !["GET", "HEAD"].includes(init.method.toUpperCase());
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: writesJson
      ? { "Content-Type": "application/json", ...init.headers }
      : init?.headers,
  });
  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ error: response.statusText }));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export const getAgents = () => api<Agent[]>("/agents");
export const getWorkflows = () => api<Workflow[]>("/workflows");
export const getRuns = () => api<Run[]>("/runs");
export const getSettings = () => api<Settings>("/settings");
export const getSchedules = () => api<ScheduleStatus[]>("/schedules");
export const getRun = (id: string) => api<RunDetail>(`/runs/${id}`);

export function listenForUpdates(
  onUpdate: () => void,
  onState: (connected: boolean) => void,
) {
  const source = new EventSource("/api/events");
  source.addEventListener("update", onUpdate);
  source.onopen = () => onState(true);
  source.onerror = () => onState(false);
  return () => source.close();
}
