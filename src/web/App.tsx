import {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  Agent,
  Run,
  RunDetail,
  ScheduleStatus,
  Settings,
  Workflow,
} from "../shared/types";
import {
  api,
  getAgents,
  getRun,
  getRuns,
  getSchedules,
  getSettings,
  getWorkflows,
  listenForUpdates,
} from "./api";
import { ModelPicker } from "./ModelPicker";

type Page = "home" | "agents" | "workflows" | "runs" | "settings";
type Notice = { kind: "error" | "success"; text: string } | null;

const emptyAgent: Omit<Agent, "id"> = {
  name: "",
  role: "",
  systemPrompt: "",
  model: "",
  tools: ["write"],
  memory: [],
  skills: [],
  approval: "publish",
  guardrails: {
    maxCostUsd: 2,
    maxTurns: 12,
    callsPerHour: 30,
    blockedActions: [],
  },
  schedule: {
    enabled: false,
    expression: "0 9 * * 1",
    prompt: "",
    workflowId: null,
  },
  telegram: false,
};

const emptyWorkflow: Omit<Workflow, "id"> = {
  name: "",
  description: "",
  requiresSource: false,
  entryNode: "",
  nodes: [],
  edges: [],
};
const terminal = new Set(["completed", "failed", "cancelled"]);

function paidSetupReady(settings: Settings | null | undefined) {
  return Boolean(settings?.providerConfigured && settings.databaseReady && settings.budgetUsd > settings.spentUsd && !settings.unknownCostRuns);
}

function dollars(value: number | null | undefined) {
  return value == null ? "Pending" : `$${value.toFixed(4)}`;
}

function when(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

function runTitle(prompt: string) {
  const reference = "\n\nTelegram command reference: ";
  const referenceAt = prompt.lastIndexOf(reference);
  const request = (referenceAt >= 0 ? prompt.slice(0, referenceAt) : prompt).trim();
  if (!request.startsWith("Conversation so far:\n")) return request;
  const marker = "\n\nUser: ";
  const latest = request.lastIndexOf(marker);
  return latest >= 0
    ? request.slice(latest + marker.length).trim() || request
    : request;
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    home: "M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z",
    agents:
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m13 10v-2a4 4 0 0 0-3-3.87m-2-12a4 4 0 0 1 0 7.75",
    workflow: "M6 3v12m0-6h8a4 4 0 0 1 4 4v8m-3-3 3 3 3-3M3 6l3-3 3 3",
    runs: "M8 5v14l11-7z",
    settings:
      "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7m7.4-.9 1.6 1.2-2 3.4-1.9-.8a8 8 0 0 1-2.1 1.2l-.3 2.1h-4l-.3-2.1a8 8 0 0 1-2.1-1.2l-1.9.8-2-3.4 1.6-1.2a8 8 0 0 1 0-2.4L3.4 11l2-3.4 1.9.8a8 8 0 0 1 2.1-1.2l.3-2.1h4l.3 2.1a8 8 0 0 1 2.1 1.2l1.9-.8 2 3.4-1.6 1.2a8 8 0 0 1 0 2.4Z",
    plus: "M12 5v14M5 12h14",
    close: "m6 6 12 12M18 6 6 18",
    edit: "m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10z",
    trash: "M4 7h16M9 11v6m6-6v6M6 7l1 14h10l1-14m-9 0V4h6v3",
    chevron: "m9 18 6-6-6-6",
    code: "m8 9-4 3 4 3m8-6 4 3-4 3m-2-9-4 12",
    external:
      "M14 3h7v7m0-7L10 14M19 13v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h7",
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

export function App() {
  const [page, setPage] = useState<Page>(() =>
    new URLSearchParams(window.location.search).has("run") ? "runs" : "home",
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("run"),
  );
  const [agents, setAgents] = useState<Agent[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [schedules, setSchedules] = useState<ScheduleStatus[]>([]);
  const [online, setOnline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice>(null);

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      getAgents(),
      getWorkflows(),
      getRuns(),
      getSettings(),
      getSchedules(),
    ]);
    if (results[0].status === "fulfilled") setAgents(results[0].value);
    if (results[1].status === "fulfilled") setWorkflows(results[1].value);
    if (results[2].status === "fulfilled") setRuns(results[2].value);
    if (results[3].status === "fulfilled") setSettings(results[3].value);
    if (results[4].status === "fulfilled") setSchedules(results[4].value);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected")
      setNotice({
        kind: "error",
        text:
          failed.reason instanceof Error
            ? failed.reason.message
            : "Could not load OrbitFlow.",
      });
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => listenForUpdates(() => void refresh(), setOnline), [refresh]);

  const notify = (
    kind: Notice extends infer _ ? "error" | "success" : never,
    text: string,
  ) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice(null), 4000);
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => setPage("home")}
          aria-label="OrbitFlow home"
        >
          <span className="brand-mark">
            <span />
          </span>
          <span>OrbitFlow</span>
        </button>
        <nav aria-label="Main navigation">
          {(
            [
              ["home", "Overview"],
              ["agents", "Agents"],
              ["workflows", "Workflows"],
              ["runs", "Runs"],
              ["settings", "Setup"],
            ] as [Page, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              aria-label={label}
              className={page === key ? "active" : ""}
              onClick={() => setPage(key)}
            >
              <Icon name={key === "workflows" ? "workflow" : key} />
              <span>{label}</span>
              {key === "runs" && runs.some((r) => r.status === "running") && (
                <i />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-status">
          <span className={`pulse ${online ? "ok" : ""}`} />
          <div>
            <strong>{online ? "Live updates" : "Reconnecting"}</strong>
            <small>{settings?.runtime || "Runtime unknown"}</small>
          </div>
        </div>
      </aside>
      <main>
        {notice && (
          <div className={`toast ${notice.kind}`}>
            {notice.text}
            <button onClick={() => setNotice(null)}>
              <Icon name="close" />
            </button>
          </div>
        )}
        {loading ? (
          <Loading />
        ) : page === "home" ? (
          <Home
            agents={agents}
            workflows={workflows}
            runs={runs}
            settings={settings}
            go={setPage}
            openRun={(id) => { setSelectedRunId(id); setPage("runs"); }}
            notify={notify}
            refresh={refresh}
          />
        ) : page === "agents" ? (
          <Agents
            agents={agents}
            workflows={workflows}
            schedules={schedules}
            refresh={refresh}
            notify={notify}
          />
        ) : page === "workflows" ? (
          <Workflows
            agents={agents}
            workflows={workflows}
            settings={settings}
            refresh={refresh}
            notify={notify}
          />
        ) : page === "runs" ? (
          <Runs
            runs={runs}
            workflows={workflows}
            agents={agents}
            selectedId={selectedRunId}
            setSelectedId={setSelectedRunId}
            refresh={refresh}
            notify={notify}
          />
        ) : (
          <Setup settings={settings} agents={agents} />
        )}
      </main>
    </div>
  );
}

function Loading() {
  return (
    <div className="loading">
      <span className="spinner" />
      <p>Opening OrbitFlow…</p>
    </div>
  );
}

function PageHead({
  eyebrow,
  title,
  copy,
  action,
}: {
  eyebrow?: string;
  title: string;
  copy: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{copy}</p>
      </div>
      {action}
    </header>
  );
}

function Home({
  agents,
  workflows,
  runs,
  settings,
  go,
  openRun,
  notify,
  refresh,
}: {
  agents: Agent[];
  workflows: Workflow[];
  runs: Run[];
  settings: Settings | null;
  go: (p: Page) => void;
  openRun: (id: string) => void;
  notify: (k: "error" | "success", t: string) => void;
  refresh: () => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const [workflowId, setWorkflowId] = useState(workflows[0]?.id || "");
  const [parentRunId, setParentRunId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const recent = runs.slice(0, 4);
  const selectedWorkflow = workflows.find(
    (workflow) => workflow.id === workflowId,
  );
  const approvedSources = runs.filter(
    (run) => run.status === "completed" && run.revisionId,
  );
  async function start(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || !workflowId) return;
    if (selectedWorkflow?.requiresSource && !parentRunId) {
      notify("error", "Choose an approved source application.");
      return;
    }
    setSubmitting(true);
    try {
      await api<Run>("/runs", {
        method: "POST",
        body: JSON.stringify({
          workflowId,
          prompt: prompt.trim(),
          ...(selectedWorkflow?.requiresSource ? { parentRunId } : {}),
        }),
      });
      setPrompt("");
      setParentRunId("");
      await refresh();
      go("runs");
      notify("success", "Run started.");
    } catch (error) {
      notify(
        "error",
        error instanceof Error ? error.message : "Could not start run.",
      );
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="page home-page">
      <PageHead
        eyebrow="Local agent studio"
        title="Turn a clear request into working software."
        copy="Design the team, watch every handoff, and keep the source and preview together."
      />
      <section className="composer-card">
        <form onSubmit={start}>
          <label htmlFor="home-prompt">What should your agents build?</label>
          <textarea
            id="home-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Build a workout tracker where I can create routines, log completed workouts, and see weekly progress"
          />
          <div className="composer-actions">
            <select
              aria-label="Workflow"
              value={workflowId}
              onChange={(e) => {
                setWorkflowId(e.target.value);
                setParentRunId("");
              }}
            >
              {workflows.length === 0 && (
                <option value="">Create or load a workflow first</option>
              )}
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            {selectedWorkflow?.requiresSource && (
              <select
                aria-label="Approved source application"
                value={parentRunId}
                onChange={(e) => setParentRunId(e.target.value)}
              >
                <option value="">Choose approved source</option>
                {approvedSources.map((run) => (
                  <option key={run.id} value={run.id}>
                    {runTitle(run.prompt)}
                  </option>
                ))}
              </select>
            )}
            <button
              className="primary"
              disabled={
                submitting ||
                !workflowId ||
                !prompt.trim() ||
                (!!selectedWorkflow?.requiresSource && !parentRunId)
              }
            >
              {submitting ? (
                <span className="spinner small" />
              ) : (
                <Icon name="runs" />
              )}{" "}
              Start run
            </button>
          </div>
        </form>
      </section>
      <section className="metric-grid">
        <button onClick={() => go("agents")}>
          <span>Agents</span>
          <strong>{agents.length}</strong>
          <small>{agents.filter((a) => a.telegram).length} on Telegram</small>
        </button>
        <button onClick={() => go("workflows")}>
          <span>Workflows</span>
          <strong>{workflows.length}</strong>
          <small>Editable graphs</small>
        </button>
        <button onClick={() => go("runs")}>
          <span>Runs</span>
          <strong>{runs.length}</strong>
          <small>
            {runs.filter((r) => r.status === "running").length} active
          </small>
        </button>
        <button onClick={() => go("settings")}>
          <span>Runtime</span>
          <strong className="metric-word">
            {paidSetupReady(settings) ? "Configured" : "Setup"}
          </strong>
          <small>{settings?.runtimeVersion || "Check configuration"}</small>
        </button>
      </section>
      <section className="split-section">
        <div className="panel">
          <div className="panel-title">
            <div>
              <span className="eyebrow">Activity</span>
              <h2>Recent runs</h2>
            </div>
            <button className="text-button" onClick={() => go("runs")}>
              View all <span>→</span>
            </button>
          </div>
          {recent.length ? (
            <div className="run-list">
              {recent.map((run) => (
                <button key={run.id} onClick={() => openRun(run.id)}>
                  <Status status={run.status} />
                  <div>
                    <strong>{runTitle(run.prompt)}</strong>
                    <small>
                      {when(run.updatedAt)} · {run.steps} steps
                    </small>
                  </div>
                  <span className="cost">{dollars(run.costUsd)}</span>
                </button>
              ))}
            </div>
          ) : (
            <Empty
              compact
              title="No runs yet"
              copy="Load a template, then send your first build request."
            />
          )}
        </div>
        <div className="panel system-card">
          <span className="eyebrow">System check</span>
          <h2>
            {paidSetupReady(settings)
              ? "Ready to run"
              : "Finish local setup"}
          </h2>
          <Check
            ok={!!settings?.databaseReady}
            label="PostgreSQL"
            detail="Durable state"
          />
          <Check
            ok={paidSetupReady(settings)}
            label="Model provider"
            detail={
              settings
                ? `${dollars(settings.spentUsd)} of $${settings.budgetUsd.toFixed(2)} budget`
                : "Not reported"
            }
          />
          <Check
            ok={!!settings?.telegramConfigured}
            label="Telegram"
            detail={
              settings?.telegramUsername
                ? `@${settings.telegramUsername}`
                : "Optional until channel demo"
            }
          />
          <button className="secondary full" onClick={() => go("settings")}>
            Open setup
          </button>
        </div>
      </section>
    </div>
  );
}

function Check({
  ok,
  label,
  detail,
}: {
  ok: boolean;
  label: string;
  detail: string;
}) {
  return (
    <div className="check-row">
      <span className={ok ? "check ok" : "check"}>{ok ? "✓" : "!"}</span>
      <div>
        <strong>{label}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function Agents({
  agents,
  workflows,
  schedules,
  refresh,
  notify,
}: {
  agents: Agent[];
  workflows: Workflow[];
  schedules: ScheduleStatus[];
  refresh: () => Promise<void>;
  notify: (k: "error" | "success", t: string) => void;
}) {
  const [editing, setEditing] = useState<Agent | "new" | null>(null);
  const [query, setQuery] = useState("");
  const filtered = agents.filter((a) =>
    `${a.name} ${a.role}`.toLowerCase().includes(query.toLowerCase()),
  );
  async function remove(agent: Agent) {
    if (
      !window.confirm(
        `Delete ${agent.name}? Referenced agents cannot be deleted.`,
      )
    )
      return;
    try {
      await api(`/agents/${agent.id}`, { method: "DELETE" });
      await refresh();
      notify("success", "Agent deleted.");
    } catch (error) {
      notify(
        "error",
        error instanceof Error ? error.message : "Could not delete agent.",
      );
    }
  }
  return (
    <div className="page">
      <PageHead
        eyebrow="Team"
        title="Agents"
        copy="Configure how each agent works, when it runs, and what it may do."
        action={
          <button className="primary" onClick={() => setEditing("new")}>
            <Icon name="plus" /> New agent
          </button>
        }
      />
      <div className="toolbar">
        <input
          className="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search agents"
        />
        <span>
          {filtered.length} agent{filtered.length === 1 ? "" : "s"}
        </span>
      </div>
      {filtered.length ? (
        <div className="agent-grid">
          {filtered.map((agent) => (
            <article className="agent-card" key={agent.id}>
              <div className="agent-top">
                <Avatar name={agent.name} />
                <div className="card-actions">
                  <button
                    aria-label={`Edit ${agent.name}`}
                    onClick={() => setEditing(agent)}
                  >
                    <Icon name="edit" />
                  </button>
                  <button
                    aria-label={`Delete ${agent.name}`}
                    onClick={() => void remove(agent)}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </div>
              <h2>{agent.name}</h2>
              <p>{agent.role}</p>
              <div className="chips">
                <span>{agent.model.split("/").pop()}</span>
                <span>{agent.tools.length} tools</span>
                {agent.telegram && <span className="telegram">Telegram</span>}
              </div>
              <div className="agent-meta">
                <div>
                  <small>Approval</small>
                  <strong>{statusLabel(agent.approval)}</strong>
                </div>
                <div>
                  <small>Limit</small>
                  <strong>${agent.guardrails.maxCostUsd.toFixed(2)}</strong>
                </div>
                <div>
                  <small>Schedule</small>
                  <strong>
                    {schedules.find((item) => item.agentId === agent.id)?.error
                      ? "Error"
                      : schedules.find((item) => item.agentId === agent.id)?.nextAt
                        ? when(schedules.find((item) => item.agentId === agent.id)!.nextAt!)
                        : agent.schedule.enabled ? "Pending" : "Off"}
                  </strong>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title="No agents found"
          copy="Create an agent with a role, tools, memory, and limits."
          action={
            <button className="primary" onClick={() => setEditing("new")}>
              Create agent
            </button>
          }
        />
      )}
      {editing && (
        <AgentEditor
          agent={editing === "new" ? null : editing}
          workflows={workflows}
          scheduleStatus={editing === "new" ? undefined : schedules.find((item) => item.agentId === editing.id)}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
            notify(
              "success",
              editing === "new" ? "Agent created." : "Agent updated.",
            );
          }}
          notify={notify}
        />
      )}
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar">
      {name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0])
        .join("")
        .toUpperCase() || "A"}
    </span>
  );
}

function AgentEditor({
  agent,
  workflows,
  scheduleStatus,
  onClose,
  onSaved,
  notify,
  workflowContext,
}: {
  agent: Agent | null;
  workflows: Workflow[];
  scheduleStatus?: ScheduleStatus;
  onClose: () => void;
  onSaved: () => void;
  notify: (k: "error" | "success", t: string) => void;
  workflowContext?: string;
}) {
  const [draft, setDraft] = useState<Omit<Agent, "id"> & { id?: string }>(
    agent ? structuredClone(agent) : structuredClone(emptyAgent),
  );
  const [skillName, setSkillName] = useState("");
  const [skillSteps, setSkillSteps] = useState("");
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof draft>(
    key: K,
    value: (typeof draft)[K],
  ) => setDraft((old) => ({ ...old, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api<Agent>(agent ? `/agents/${agent.id}` : "/agents", {
        method: agent ? "PUT" : "POST",
        body: JSON.stringify(draft),
      });
      await onSaved();
    } catch (error) {
      notify(
        "error",
        error instanceof Error ? error.message : "Could not save agent.",
      );
    } finally {
      setSaving(false);
    }
  }
  function addSkill() {
    if (!skillName.trim() || !skillSteps.trim()) return;
    set("skills", [
      ...draft.skills,
      { name: skillName.trim(), steps: lines(skillSteps) },
    ]);
    setSkillName("");
    setSkillSteps("");
  }
  return (
    <Modal
      title={agent ? "Edit agent" : "New agent"}
      subtitle="Changes apply to new runs; active runs keep their saved settings."
      onClose={onClose}
      wide
    >
      <form onSubmit={submit} className="editor-form">
        {workflowContext && (
          <p className="workflow-agent-context">
            Editing the agent used by {workflowContext}. Saving updates this agent
            everywhere it is assigned, for new runs. Your workflow draft is kept separately.
          </p>
        )}
        <section>
          <h3>Identity</h3>
          <div className="form-grid">
            <Field label="Name">
              <input
                required
                value={draft.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </Field>
            <Field label="Role">
              <input
                required
                value={draft.role}
                onChange={(e) => set("role", e.target.value)}
                placeholder="Builder, reviewer, researcher…"
              />
            </Field>
            <ModelPicker value={draft.model} onChange={(model) => set("model", model)} />
            <Field label="Approval rule">
              <select
                value={draft.approval}
                onChange={(e) =>
                  set("approval", e.target.value as Agent["approval"])
                }
              >
                <option value="never">Work autonomously</option>
                <option value="publish">Approve before preview release</option>
                <option value="always">Approve every turn</option>
              </select>
            </Field>
          </div>
          <Field label="System prompt">
            <textarea
              required
              rows={4}
              value={draft.systemPrompt}
              onChange={(e) => set("systemPrompt", e.target.value)}
              placeholder="Describe the agent's job, standards, and expected output."
            />
          </Field>
        </section>
        <section>
          <h3>Tools and context</h3>
          <div className="form-grid">
            <Field label="Tools" hint="One tool name per line">
              <textarea
                rows={5}
                value={draft.tools.join("\n")}
                onChange={(e) => set("tools", lines(e.target.value))}
              />
            </Field>
            <Field label="Memory" hint="Persistent facts, one per line">
              <textarea
                rows={5}
                value={draft.memory.join("\n")}
                onChange={(e) => set("memory", lines(e.target.value))}
              />
            </Field>
          </div>
          <Field label="Skills" hint="Reusable procedures run as ordered steps">
            <div className="skills-list">
              {draft.skills.map((skill, index) => (
                <div className="skill-row" key={`${skill.name}-${index}`}>
                  <div>
                    <strong>{skill.name}</strong>
                    <small>{skill.steps.join(" → ")}</small>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      set(
                        "skills",
                        draft.skills.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              ))}
            </div>
          </Field>
          <div className="skill-builder">
            <input
              aria-label="Skill name"
              value={skillName}
              onChange={(e) => setSkillName(e.target.value)}
              placeholder="Skill name"
            />
            <textarea
              aria-label="Skill steps"
              rows={2}
              value={skillSteps}
              onChange={(e) => setSkillSteps(e.target.value)}
              placeholder="One step per line"
            />
            <button type="button" className="secondary" onClick={addSkill}>
              Add skill
            </button>
          </div>
        </section>
        <section>
          <h3>Guardrails</h3>
          <p className="muted">Reported spending stops further steps at the limit. A response already in flight can exceed it.</p>
          <div className="form-grid three">
            <Field label="Cost limit per run (USD)">
              <input
                type="number"
                min="0"
                step="0.01"
                value={draft.guardrails.maxCostUsd}
                onChange={(e) =>
                  set("guardrails", {
                    ...draft.guardrails,
                    maxCostUsd: Number(e.target.value),
                  })
                }
              />
            </Field>
            <Field label="Max turns">
              <input
                type="number"
                min="1"
                value={draft.guardrails.maxTurns}
                onChange={(e) =>
                  set("guardrails", {
                    ...draft.guardrails,
                    maxTurns: Number(e.target.value),
                  })
                }
              />
            </Field>
            <Field label="Calls per hour">
              <input
                type="number"
                min="1"
                value={draft.guardrails.callsPerHour}
                onChange={(e) =>
                  set("guardrails", {
                    ...draft.guardrails,
                    callsPerHour: Number(e.target.value),
                  })
                }
              />
            </Field>
          </div>
          <Field
            label="Blocked actions"
            hint="Exact native tool names, one per line"
          >
            <textarea
              rows={3}
              value={draft.guardrails.blockedActions.join("\n")}
              onChange={(e) =>
                set("guardrails", {
                  ...draft.guardrails,
                  blockedActions: lines(e.target.value),
                })
              }
            />
          </Field>
        </section>
        <section>
          <h3>Schedule and channel</h3>
          <div className="toggle-row">
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.schedule.enabled}
                onChange={(e) =>
                  set("schedule", {
                    ...draft.schedule,
                    enabled: e.target.checked,
                  })
                }
              />
              <span />
            </label>
            <div>
              <strong>Scheduled work</strong>
              <small>Wake this agent on the cron expression below.</small>
            </div>
          </div>
          {draft.schedule.enabled && (
            <><div className="form-grid">
              <Field label="Cron expression">
                <input
                  value={draft.schedule.expression}
                  onChange={(e) =>
                    set("schedule", {
                      ...draft.schedule,
                      expression: e.target.value,
                    })
                  }
                />
              </Field>
              <Field label="Workflow">
                <select
                  value={draft.schedule.workflowId || ""}
                  onChange={(e) =>
                    set("schedule", {
                      ...draft.schedule,
                      workflowId: e.target.value || null,
                    })
                  }
                >
                  <option value="">Run this agent alone</option>
                  {workflows.map((w) => (
                    <option value={w.id} key={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Scheduled prompt">
                <textarea
                  rows={3}
                  value={draft.schedule.prompt}
                  onChange={(e) =>
                    set("schedule", {
                      ...draft.schedule,
                      prompt: e.target.value,
                    })
                  }
                />
              </Field>
            </div><div className={`schedule-readout ${scheduleStatus?.error ? "error" : ""}`}><strong>{scheduleStatus?.error ? "Schedule error" : "Next scheduled run"}</strong><span>{scheduleStatus?.error || (scheduleStatus?.nextAt ? when(scheduleStatus.nextAt) : "Calculated after saving")}</span></div></>
          )}
          <div className="toggle-row">
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.telegram}
                onChange={(e) => set("telegram", e.target.checked)}
              />
              <span />
            </label>
            <div>
              <strong>Telegram conversation</strong>
              <small>
                Handle plain messages in the configured bot. Workflow commands use
                their assigned agents independently of this setting.
              </small>
            </div>
          </div>
        </section>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            {workflowContext ? "Back to workflow" : "Cancel"}
          </button>
          <button className="primary" disabled={saving || !draft.model.trim()}>
            {saving ? "Saving…" : workflowContext ? "Save agent & return" : "Save agent"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function lines(value: string) {
  return value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </label>
  );
}

function Workflows({
  agents,
  workflows,
  settings,
  refresh,
  notify,
}: {
  agents: Agent[];
  workflows: Workflow[];
  settings: Settings | null;
  refresh: () => Promise<void>;
  notify: (k: "error" | "success", t: string) => void;
}) {
  const [editing, setEditing] = useState<Workflow | "new" | null>(null);
  const [templates, setTemplates] = useState<Workflow[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  useEffect(() => {
    if (showTemplates)
      api<Workflow[]>("/templates")
        .then(setTemplates)
        .catch((e) => notify("error", e.message));
  }, [showTemplates]);
  async function load(id: string) {
    try {
      const copy = await api<Workflow>(`/templates/${id}/load`, {
        method: "POST",
      });
      await refresh();
      setShowTemplates(false);
      setEditing(copy);
      notify("success", "Template loaded as an editable workflow.");
    } catch (error) {
      notify(
        "error",
        error instanceof Error ? error.message : "Could not load template.",
      );
    }
  }
  async function remove(workflow: Workflow) {
    if (!window.confirm(`Delete ${workflow.name}?`)) return;
    try {
      await api(`/workflows/${workflow.id}`, { method: "DELETE" });
      await refresh();
      notify("success", "Workflow deleted.");
    } catch (error) {
      notify(
        "error",
        error instanceof Error ? error.message : "Could not delete workflow.",
      );
    }
  }
  async function copyWorkflowId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      notify("success", "Workflow ID copied.");
    } catch {
      notify("error", "Could not copy the workflow ID.");
    }
  }
  return (
    <div className="page">
      <PageHead
        eyebrow="Orchestration"
        title="Workflows"
        copy="Connect agents by outcome. A route can loop back for another revision."
        action={
          <div className="head-actions">
            <button
              className="secondary"
              onClick={() => setShowTemplates(true)}
            >
              Browse templates
            </button>
            <button className="primary" onClick={() => setEditing("new")}>
              <Icon name="plus" /> New workflow
            </button>
          </div>
        }
      />
      {workflows.length ? (
        <div className="workflow-list">
          {workflows.map((w) => (
            <article key={w.id}>
              <div className="workflow-info">
                <span className="flow-icon">
                  <Icon name="workflow" />
                </span>
                <div>
                  <h2>{w.name}</h2>
                  <p>{w.description}</p>
                  <p className="workflow-id">
                    {w.id}{" "}
                    <button onClick={() => void copyWorkflowId(w.id)}>
                      Copy ID
                    </button>
                  </p>
                  <div className="chips">
                    <span>{w.nodes.length} agents</span>
                    <span>{w.edges.length} routes</span>
                    <span>
                      {w.edges.some((e) => pathExists(w, e.to, e.from))
                        ? "Feedback loop"
                        : "Linear"}
                    </span>
                  </div>
                </div>
              </div>
              <MiniGraph workflow={w} agents={agents} />
              <div className="card-actions">
                <button onClick={() => setEditing(w)}>
                  <Icon name="edit" /> Edit
                </button>
                <button
                  aria-label={`Delete ${w.name}`}
                  onClick={() => void remove(w)}
                >
                  <Icon name="trash" />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title="Build your first workflow"
          copy="Load a ready-made application workflow or connect your own agents."
          action={
            <button className="primary" onClick={() => setShowTemplates(true)}>
              Browse templates
            </button>
          }
        />
      )}
      {showTemplates && (
        <Modal
          title="Workflow templates"
          subtitle="Loading creates an independent copy with editable agents."
          onClose={() => setShowTemplates(false)}
        >
          <div className="template-list">
            {templates.map((t) => (
              <button key={t.id} onClick={() => void load(t.id)}>
                <span className="flow-icon">
                  <Icon name="workflow" />
                </span>
                <div>
                  <strong>{t.name}</strong>
                  <p>{t.description}</p>
                  <small>
                    {t.nodes.length} agents · {t.edges.length} routes
                  </small>
                </div>
                <span>Use template →</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {editing && (
        <WorkflowEditor
          workflow={editing === "new" ? null : editing}
          agents={agents}
          workflows={workflows}
          settings={settings}
          refresh={refresh}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
            notify(
              "success",
              editing === "new" ? "Workflow created." : "Workflow updated.",
            );
          }}
          notify={notify}
        />
      )}
    </div>
  );
}

function pathExists(
  w: Workflow,
  start: string,
  target: string,
  seen = new Set<string>(),
): boolean {
  if (start === target) return true;
  if (seen.has(start)) return false;
  seen.add(start);
  return w.edges
    .filter((e) => e.from === start)
    .some((e) => pathExists(w, e.to, target, seen));
}
function modelLabel(model: string) {
  return model.replace(/^openrouter\//, "");
}

function MiniGraph({
  workflow,
  agents,
}: {
  workflow: Workflow;
  agents: Agent[];
}) {
  return (
    <div className="mini-graph" aria-label="Assigned agents">
      {workflow.nodes.slice(0, 4).map((n) => {
        const agent = agents.find((a) => a.id === n.agentId);
        return (
          <div key={n.id}>
            <strong>
              {n.label} <span>· {agent?.name || "Agent missing"}</span>
            </strong>
            <code title={agent?.model}>
              {agent ? modelLabel(agent.model) : "Choose an agent"}
            </code>
          </div>
        );
      })}
      {workflow.nodes.length > 4 && (
        <small>+{workflow.nodes.length - 4} more nodes</small>
      )}
    </div>
  );
}

function WorkflowTelegram({
  workflow,
  settings,
  agents,
  dirty,
  notify,
}: {
  workflow: Workflow | null;
  settings: Settings | null;
  agents: Agent[];
  dirty: boolean;
  notify: (k: "error" | "success", t: string) => void;
}) {
  const chatAgents = agents.filter((agent) => agent.telegram);
  const command = workflow
    ? workflow.requiresSource
      ? `/improve ${workflow.id} <approved-run-id> <your change>`
      : `/build ${workflow.id} <your request>`
    : null;
  async function copyCommand() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      notify(
        "success",
        "Command template copied. Replace the placeholders before sending.",
      );
    } catch {
      notify(
        "error",
        "Could not copy. Select and copy the command text instead.",
      );
    }
  }
  return (
    <section className="workflow-telegram" aria-label="Start from Telegram">
      <div className="telegram-heading">
        <h3>Start from Telegram</h3>
        <span
          className={`telegram-status ${settings?.telegramConfigured ? "configured" : ""}`}
        >
          {!settings
            ? "Checking configuration…"
            : settings.telegramConfigured
              ? "Bot configured"
              : "Bot not configured"}
        </span>
      </div>
      <div className="telegram-columns">
        <div>
          <p>
            {settings?.telegramUsername ? (
              <>
                Send to{" "}
                <a
                  href={`https://t.me/${encodeURIComponent(settings.telegramUsername)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  @{settings.telegramUsername}
                </a>{" "}
                from your authorized Telegram chat.
              </>
            ) : (
              "Use the bot and authorized chat configured in Settings."
            )}
          </p>
          {command ? (
            <>
              <div className="telegram-command">
                <code>{command}</code>
                <button
                  type="button"
                  className="secondary"
                  disabled={dirty || !settings?.telegramConfigured}
                  onClick={() => void copyCommand()}
                >
                  Copy template
                </button>
              </div>
              <p className="telegram-note">
                {dirty
                  ? "Save workflow changes first. This command uses the saved workflow."
                  : workflow?.requiresSource
                    ? "Replace the placeholders. Find a completed, approved source run in Runs."
                    : "Replace <your request> with what you want to build. This command starts this workflow."}
              </p>
            </>
          ) : (
            <p className="telegram-note">
              Save this workflow to get its Telegram command.
            </p>
          )}
          {settings && !settings.telegramConfigured && (
            <p className="telegram-note">
              Configure the bot token and allowed chat before using Telegram.
              See Settings for setup.
            </p>
          )}
        </div>
        <div className="telegram-chat">
          <strong>What happens if I just text?</strong>
          <p>
            {chatAgents.length === 1 ? (
              <>
                Plain messages normally go to <b>{chatAgents[0].name}</b>, using{" "}
                <code>{modelLabel(chatAgents[0].model)}</code>.
              </>
            ) : chatAgents.length > 1 ? (
              "Multiple agents have Telegram conversation enabled. Choose one in Agents so plain messages can be routed."
            ) : (
              "No conversation agent is selected. Enable Telegram conversation on one agent to handle plain messages."
            )}
          </p>
          <p>
            They do not automatically start this workflow. If the bot has just
            asked for a change after <code>/improve</code>, your next message
            continues that request.
          </p>
        </div>
      </div>
    </section>
  );
}

function WorkflowEditor({
  workflow,
  agents,
  workflows,
  settings,
  refresh,
  onClose,
  onSaved,
  notify,
}: {
  workflow: Workflow | null;
  agents: Agent[];
  workflows: Workflow[];
  settings: Settings | null;
  refresh: () => Promise<void>;
  onClose: () => void;
  onSaved: () => void;
  notify: (k: "error" | "success", t: string) => void;
}) {
  const [draft, setDraft] = useState<Omit<Workflow, "id"> & { id?: string }>(
    workflow ? structuredClone(workflow) : structuredClone(emptyWorkflow),
  );
  const [selected, setSelected] = useState<string | null>(
    workflow?.entryNode || null,
  );
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [saving, setSaving] = useState(false);
  const selectedNode = draft.nodes.find((node) => node.id === selected);
  const selectedAgent = agents.find(
    (agent) => agent.id === selectedNode?.agentId,
  );
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(workflow || emptyWorkflow);
  function addNode(agentId: string) {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;
    const id = `node-${crypto.randomUUID()}`;
    setDraft((d) => ({
      ...d,
      entryNode: d.entryNode || id,
      nodes: [
        ...d.nodes,
        {
          id,
          agentId,
          label: agent.name,
          x: 40 + (d.nodes.length % 2) * 350,
          y: 80 + Math.floor(d.nodes.length / 2) * 180,
          terminalOutcomes: [],
        },
      ],
    }));
    setSelected(id);
  }
  function moveNode(id: string, x: number, y: number) {
    setDraft((d) => ({
      ...d,
      nodes: d.nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              x: Math.max(20, x),
              y: Math.max(20, y),
            }
          : n,
      ),
    }));
  }
  function removeNode(id: string) {
    setDraft((d) => ({
      ...d,
      entryNode:
        d.entryNode === id
          ? d.nodes.find((n) => n.id !== id)?.id || ""
          : d.entryNode,
      nodes: d.nodes.filter((n) => n.id !== id),
      edges: d.edges.filter((e) => e.from !== id && e.to !== id),
    }));
    setSelected(null);
  }
  function addEdge() {
    if (draft.nodes.length < 2) return;
    setDraft((d) => ({
      ...d,
      edges: [
        ...d.edges,
        {
          id: `edge-${crypto.randomUUID()}`,
          from: d.nodes[0].id,
          to: d.nodes[1].id,
          outcome: "*",
        },
      ],
    }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.entryNode) {
      notify("error", "Add at least one agent node.");
      return;
    }
    setSaving(true);
    try {
      await api<Workflow>(
        workflow ? `/workflows/${workflow.id}` : "/workflows",
        { method: workflow ? "PUT" : "POST", body: JSON.stringify(draft) },
      );
      await onSaved();
    } catch (error) {
      notify(
        "error",
        error instanceof Error ? error.message : "Could not save workflow.",
      );
    } finally {
      setSaving(false);
    }
  }
  if (editingAgent)
    return (
      <AgentEditor
        agent={editingAgent}
        workflows={workflows}
        workflowContext={draft.name || "this workflow"}
        onClose={() => setEditingAgent(null)}
        onSaved={async () => {
          await refresh();
          setEditingAgent(null);
          notify("success", "Agent updated. Workflow draft preserved.");
        }}
        notify={notify}
      />
    );
  return (
    <Modal
      title={workflow ? "Edit workflow" : "New workflow"}
      subtitle="Choose who does the work, inspect their model, and route their outcomes. Changes apply to new runs."
      onClose={onClose}
      extraWide
    >
      <form onSubmit={submit} className="workflow-editor">
        <div className="workflow-meta">
          <Field label="Name">
            <input
              required
              value={draft.name}
              onChange={(e) =>
                setDraft((d) => ({ ...d, name: e.target.value }))
              }
            />
          </Field>
          <Field label="Description">
            <input
              value={draft.description}
              onChange={(e) =>
                setDraft((d) => ({ ...d, description: e.target.value }))
              }
            />
          </Field>
        </div>
        <WorkflowTelegram
          workflow={workflow}
          settings={settings}
          agents={agents}
          dirty={dirty}
          notify={notify}
        />
        <div className="builder-layout">
          <div className="workflow-canvas-panel">
            <div className="canvas-toolbar">
              <div>
                <h3>Workflow steps</h3>
                <p>Select a step to inspect its agent.</p>
              </div>
              <label className="add-agent-control">
                <span>Add agent</span>
                <select
                  aria-label="Add agent node"
                  value=""
                  onChange={(e) => addNode(e.target.value)}
                  disabled={!agents.length}
                >
                  <option value="">
                    {agents.length
                      ? "Choose an agent…"
                      : "Create an agent first"}
                  </option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {modelLabel(a.model)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="canvas-scroll">
              <GraphCanvas
                workflow={draft as Workflow}
                agents={agents}
                selected={selected}
                select={setSelected}
                move={moveNode}
              />
            </div>
            <div className="canvas-legend">
              Drag to arrange · Tab and Enter to select · Arrow keys to move
            </div>
            <div className="workflow-start-settings">
              <Field label="First step">
                <select
                  value={draft.entryNode}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, entryNode: e.target.value }))
                  }
                >
                  <option value="">Choose a step</option>
                  {draft.nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="source-checkbox">
                <input
                  type="checkbox"
                  checked={!!draft.requiresSource}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      requiresSource: e.target.checked,
                    }))
                  }
                />
                <span>
                  <strong>Start from an approved application</strong>
                  <small>For workflows that improve an existing app.</small>
                </span>
              </label>
            </div>
          </div>
          <aside className="node-inspector" aria-label="Selected step settings">
            {selectedNode ? (
              <>
                <div className="inspector-heading">
                  <h3>{selectedNode.label || "Selected step"}</h3>
                  <span>
                    {draft.entryNode === selectedNode.id
                      ? "First step"
                      : "Workflow step"}
                  </span>
                </div>
                <Field label="Step label">
                  <input
                    value={selectedNode.label}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        nodes: d.nodes.map((n) =>
                          n.id === selected
                            ? { ...n, label: e.target.value }
                            : n,
                        ),
                      }))
                    }
                  />
                </Field>
                <Field label="Assigned agent">
                  <select
                    value={selectedNode.agentId}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        nodes: d.nodes.map((n) =>
                          n.id === selected
                            ? { ...n, agentId: e.target.value }
                            : n,
                        ),
                      }))
                    }
                  >
                    {!selectedAgent && (
                      <option value={selectedNode.agentId}>
                        Agent missing — choose a replacement
                      </option>
                    )}
                    {agents.map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.name} · {modelLabel(a.model)}
                      </option>
                    ))}
                  </select>
                </Field>
                {selectedAgent ? (
                  <>
                    <dl className="node-agent-facts">
                      <div>
                        <dt>Model</dt>
                        <dd>
                          <code>{selectedAgent.model}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Available tools</dt>
                        <dd>
                          {selectedAgent.tools
                            .filter(
                              (tool) =>
                                !selectedAgent.guardrails.blockedActions.includes(
                                  tool,
                                ),
                            )
                            .join(", ") || "None"}
                        </dd>
                      </div>
                      <div>
                        <dt>Approval</dt>
                        <dd>
                          {selectedAgent.approval === "always"
                            ? "Before each turn"
                            : selectedAgent.approval === "publish"
                              ? "Before preview release"
                              : "No manual approval"}
                        </dd>
                      </div>
                    </dl>
                    <button
                      type="button"
                      className="secondary edit-assigned-agent"
                      onClick={() => setEditingAgent(selectedAgent)}
                    >
                      <Icon name="edit" /> Edit agent settings
                    </button>
                    <p className="inspector-note">
                      Agent edits apply everywhere this agent is assigned.
                      Changing the assignment only affects this step.
                    </p>
                    <details className="agent-instructions">
                      <summary>System prompt & skills</summary>
                      <p>{selectedAgent.systemPrompt || "No system prompt."}</p>
                      {selectedAgent.skills.map((skill, index) => (
                        <div key={index}>
                          <strong>{skill.name}</strong>
                          <ol>
                            {skill.steps.map((step, i) => (
                              <li key={i}>{step}</li>
                            ))}
                          </ol>
                        </div>
                      ))}
                    </details>
                  </>
                ) : (
                  <p className="inspector-note">
                    This step cannot run until it has an existing agent
                    assigned.
                  </p>
                )}
                <details className="step-options">
                  <summary>Completion & removal</summary>
                  <Field
                    label="Terminal outcomes"
                    hint="One per line; finishes without a route"
                  >
                    <textarea
                      rows={2}
                      value={selectedNode.terminalOutcomes.join("\n")}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          nodes: d.nodes.map((n) =>
                            n.id === selected
                              ? {
                                  ...n,
                                  terminalOutcomes: lines(e.target.value),
                                }
                              : n,
                          ),
                        }))
                      }
                      placeholder="approved"
                    />
                  </Field>
                  <button
                    type="button"
                    className="danger-link"
                    onClick={() => removeNode(selectedNode.id)}
                  >
                    Remove step
                  </button>
                </details>
              </>
            ) : (
              <div className="inspector-empty">
                <h3>
                  {draft.nodes.length
                    ? "Select a step"
                    : "Add your first agent"}
                </h3>
                <p>
                  {draft.nodes.length
                    ? "Choose a node in the graph to see its model, instructions, and settings."
                    : "Choose an agent above the canvas, then connect its outcomes below."}
                </p>
              </div>
            )}
          </aside>
        </div>
        <div className="routes">
          <div className="section-title">
            <div>
              <h3>Outcome routes</h3>
              <p>
                Use <code>*</code> as the fallback. Point a route backward to
                create a feedback loop.
              </p>
            </div>
            <button
              type="button"
              className="secondary"
              disabled={draft.nodes.length < 2}
              onClick={addEdge}
            >
              <Icon name="plus" /> Add route
            </button>
          </div>
          {draft.edges.map((edge, index) => (
            <div className="route-row" key={edge.id}>
              <select
                aria-label="From node"
                value={edge.from}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    edges: d.edges.map((item, i) =>
                      i === index ? { ...item, from: e.target.value } : item,
                    ),
                  }))
                }
              >
                {draft.nodes.map((n) => (
                  <option value={n.id} key={n.id}>
                    {n.label}
                  </option>
                ))}
              </select>
              <span>when outcome is</span>
              <input
                aria-label="Outcome condition"
                value={edge.outcome}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    edges: d.edges.map((item, i) =>
                      i === index ? { ...item, outcome: e.target.value } : item,
                    ),
                  }))
                }
                placeholder="approved"
              />
              <span>send to</span>
              <select
                aria-label="To node"
                value={edge.to}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    edges: d.edges.map((item, i) =>
                      i === index ? { ...item, to: e.target.value } : item,
                    ),
                  }))
                }
              >
                {draft.nodes.map((n) => (
                  <option value={n.id} key={n.id}>
                    {n.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label="Remove route"
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    edges: d.edges.filter((_, i) => i !== index),
                  }))
                }
              >
                <Icon name="trash" />
              </button>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={saving}>
            {saving ? "Saving…" : "Save workflow"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const graphNodeWidth = 244;
const graphNodeHeight = 118;

function GraphCanvas({
  workflow,
  agents,
  selected,
  select,
  move,
}: {
  workflow: Workflow;
  agents: Agent[];
  selected: string | null;
  select: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
}) {
  const drag = useRef<{ id: string; offsetX: number; offsetY: number } | null>(
    null,
  );
  const [dragSize, setDragSize] = useState<{ width: number; height: number } | null>(null);
  // Keep the coordinate system steady while dragging in a larger workflow.
  const width = dragSize?.width ?? Math.max(
    800,
    ...workflow.nodes.map((n) =>
      Math.ceil((n.x + graphNodeWidth + 120) / 200) * 200,
    ),
  );
  const height = dragSize?.height ?? Math.max(
    320,
    ...workflow.nodes.map((n) =>
      Math.ceil((n.y + graphNodeHeight + 60) / 160) * 160,
    ),
  );
  const point = (event: ReactPointerEvent<SVGGElement>) => {
    const svg = event.currentTarget.ownerSVGElement!;
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(
      svg.getScreenCTM()!.inverse(),
    );
  };
  const startDrag = (
    event: ReactPointerEvent<SVGGElement>,
    n: Workflow["nodes"][number],
  ) => {
    if (event.button !== 0) return;
    const position = point(event);
    drag.current = {
      id: n.id,
      offsetX: position.x - n.x,
      offsetY: position.y - n.y,
    };
    setDragSize({ width, height });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    select(n.id);
  };
  const stopDrag = () => {
    drag.current = null;
    setDragSize(null);
  };
  const node = (id: string) => workflow.nodes.find((n) => n.id === id);
  const shorten = (value: string, limit: number) =>
    value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
  return (
    <svg
      className="graph-canvas"
      viewBox={`0 0 ${width} ${height}`}
      role="group"
      aria-label="Editable workflow graph"
      style={{ aspectRatio: `${width} / ${height}` }}
    >
      <defs>
        <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="#d7ddd8" />
        </pattern>
        <marker
          id="arrow"
          markerWidth="8"
          markerHeight="8"
          refX="6"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L0,6 L7,3 z" fill="#6c7d73" />
        </marker>
      </defs>
      <rect width={width} height={height} fill="url(#grid)" />
      {!workflow.nodes.length && (
        <text className="graph-empty" x={width / 2} y={height / 2}>
          Your workflow starts with an agent
        </text>
      )}
      {workflow.edges.map((edge) => {
        const a = node(edge.from),
          b = node(edge.to);
        if (!a || !b) return null;
        if (edge.from === edge.to) {
          return (
            <g key={edge.id}>
              <path
                className="edge"
                d={`M${a.x + graphNodeWidth},${a.y + 24} C${a.x + graphNodeWidth + 100},${a.y - 20} ${a.x + graphNodeWidth + 100},${a.y + 140} ${a.x + graphNodeWidth + 3},${a.y + 94}`}
                markerEnd="url(#arrow)"
              />
              <text
                className="edge-label"
                x={a.x + graphNodeWidth + 75}
                y={a.y + 59}
              >
                {edge.outcome}
              </text>
            </g>
          );
        }
        const ax = a.x + graphNodeWidth / 2,
          ay = a.y + graphNodeHeight / 2;
        const bx = b.x + graphNodeWidth / 2,
          by = b.y + graphNodeHeight / 2;
        const dx = bx - ax,
          dy = by - ay;
        const length = Math.max(Math.hypot(dx, dy), 1),
          ux = dx / length,
          uy = dy / length;
        // Intersect the direction with the card boundary, including diagonal routes.
        const distance = Math.min(
          (graphNodeWidth / 2 + 4) / Math.max(Math.abs(ux), 0.001),
          (graphNodeHeight / 2 + 4) / Math.max(Math.abs(uy), 0.001),
        );
        const curve = workflow.edges.some(
          (other) => other.from === edge.to && other.to === edge.from,
        )
          ? 66
          : 0;
        const sx = ax + ux * distance,
          sy = ay + uy * distance;
        const ex = bx - ux * distance,
          ey = by - uy * distance;
        const cx = (sx + ex) / 2 - uy * curve,
          cy = (sy + ey) / 2 + ux * curve;
        return (
          <g key={edge.id}>
            <path
              className="edge"
              d={`M${sx},${sy} Q${cx},${cy} ${ex},${ey}`}
              markerEnd="url(#arrow)"
            />
            <text
              className="edge-label"
              x={(sx + 2 * cx + ex) / 4 - uy * 13}
              y={(sy + 2 * cy + ey) / 4 + ux * 13}
            >
              {edge.outcome}
            </text>
          </g>
        );
      })}
      {workflow.nodes.map((n) => {
        const agent = agents.find((a) => a.id === n.agentId);
        return (
          <g
            key={n.id}
            role="button"
            tabIndex={0}
            aria-label={`${n.label}: ${agent?.name || "Agent missing"}, ${agent?.model || "no model"}`}
            aria-pressed={selected === n.id}
            className={`graph-node ${selected === n.id ? "selected" : ""} ${!agent ? "missing" : ""}`}
            transform={`translate(${n.x},${n.y})`}
            onPointerDown={(e) => startDrag(e, n)}
            onPointerMove={(e) => {
              if (!drag.current || drag.current.id !== n.id) return;
              const position = point(e);
              move(
                n.id,
                Math.min(
                  width - graphNodeWidth - 120,
                  position.x - drag.current.offsetX,
                ),
                Math.min(
                  height - graphNodeHeight - 60,
                  position.y - drag.current.offsetY,
                ),
              );
            }}
            onPointerUp={stopDrag}
            onPointerCancel={stopDrag}
            onLostPointerCapture={stopDrag}
            onClick={() => select(n.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                select(n.id);
              }
              if (
                ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                  e.key,
                )
              ) {
                e.preventDefault();
                select(n.id);
                move(
                  n.id,
                  Math.min(
                    width - graphNodeWidth - 120,
                    n.x +
                      (e.key === "ArrowRight"
                        ? 10
                        : e.key === "ArrowLeft"
                          ? -10
                          : 0),
                  ),
                  Math.min(
                    height - graphNodeHeight - 60,
                    n.y +
                      (e.key === "ArrowDown"
                        ? 10
                        : e.key === "ArrowUp"
                          ? -10
                          : 0),
                  ),
                );
              }
            }}
          >
            <title>
              {n.label} · {agent?.name || "Agent missing"} ·{" "}
              {agent?.model || "Choose a replacement agent"}
            </title>
            <rect width={graphNodeWidth} height={graphNodeHeight} rx="12" />
            <circle cx="25" cy="27" r="13" />
            <text x="25" y="31" className="initial">
              {n.label[0]?.toUpperCase()}
            </text>
            <text x="47" y="32" className="node-label">
              {shorten(n.label, 23)}
            </text>
            <text x="16" y="56" className="node-agent">
              {shorten(agent?.name || "Agent missing", 31)}
            </text>
            <text x="16" y="78" className="node-model">
              {shorten(
                agent ? modelLabel(agent.model) : "Choose a replacement",
                31,
              )}
            </text>
            <text x="16" y="102" className="node-role">
              {workflow.entryNode === n.id
                ? "Starts here"
                : n.terminalOutcomes.length
                  ? `Finishes on ${shorten(n.terminalOutcomes.join(", "), 22)}`
                  : "Workflow step"}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function Runs({
  runs,
  workflows,
  agents,
  selectedId,
  setSelectedId,
  refresh,
  notify,
}: {
  runs: Run[];
  workflows: Workflow[];
  agents: Agent[];
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  refresh: () => Promise<void>;
  notify: (k: "error" | "success", t: string) => void;
}) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [prompt, setPrompt] = useState("");
  const [target, setTarget] = useState(
    workflows[0]?.id
      ? `w:${workflows[0].id}`
      : agents[0]?.id
        ? `a:${agents[0].id}`
        : "",
  );
  const [parentRunId, setParentRunId] = useState("");
  const [feedback, setFeedback] = useState("");
  const [source, setSource] = useState<
    { path: string; content: string }[] | null
  >(null);
  const [activeFile, setActiveFile] = useState("");
  const targetWorkflow = target.startsWith("w:")
    ? workflows.find((workflow) => workflow.id === target.slice(2))
    : undefined;
  const requiresSource = !!targetWorkflow?.requiresSource;
  const approvedSources = runs.filter(
    (run) => run.status === "completed" && run.revisionId,
  );
  useEffect(() => {
    if (!selectedId && runs[0]) setSelectedId(runs[0].id);
  }, [runs, selectedId]);
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    getRun(selectedId)
      .then(setDetail)
      .catch((e) => notify("error", e.message));
  }, [selectedId, runs]);
  async function start(event: FormEvent) {
    event.preventDefault();
    if (!target || !prompt.trim()) return;
    if (requiresSource && !parentRunId) {
      notify("error", "Choose an approved source application.");
      return;
    }
    const [type, id] = target.split(":");
    try {
      const run = await api<Run>("/runs", {
        method: "POST",
        body: JSON.stringify({
          [type === "w" ? "workflowId" : "agentId"]: id,
          prompt: prompt.trim(),
          ...(requiresSource ? { parentRunId } : {}),
        }),
      });
      setPrompt("");
      setParentRunId("");
      await refresh();
      setSelectedId(run.id);
      notify("success", "Run queued.");
    } catch (error) {
      notify(
        "error",
        error instanceof Error ? error.message : "Could not start run.",
      );
    }
  }
  async function improve(parent: Run) {
    const improvementWorkflow = workflows.find(
      (workflow) => workflow.requiresSource,
    );
    if (!improvementWorkflow) {
      notify(
        "error",
        "Load an improve-application template before requesting a change.",
      );
      return;
    }
    const change = window.prompt(
      "What should the agents change in this application?",
    );
    if (!change?.trim()) return;
    try {
      const run = await api<Run>("/runs", {
        method: "POST",
        body: JSON.stringify({
          workflowId: improvementWorkflow.id,
          prompt: change.trim(),
          parentRunId: parent.id,
        }),
      });
      await refresh();
      setSelectedId(run.id);
      notify("success", "Improvement run queued from the approved revision.");
    } catch (error) {
      notify(
        "error",
        error instanceof Error ? error.message : "Could not start improvement.",
      );
    }
  }
  async function action(path: string, body?: unknown) {
    if (!detail) return;
    try {
      await api(path, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      });
      await refresh();
      setDetail(await getRun(detail.run.id));
      notify("success", "Run updated.");
    } catch (error) {
      notify(
        "error",
        error instanceof Error ? error.message : "Could not update run.",
      );
    }
  }
  async function openSource(revisionId: string) {
    try {
      const result = await api<{ files: { path: string; content: string }[] }>(
        `/revisions/${revisionId}/source`,
      );
      setSource(result.files);
      setActiveFile(result.files[0]?.path || "");
    } catch (error) {
      notify(
        "error",
        error instanceof Error ? error.message : "Could not load source.",
      );
    }
  }
  async function openPreview(revisionId: string) {
    try {
      const { url } = await api<{ url: string }>(
        `/revisions/${revisionId}/preview`,
      );
      window.open(url, "orbitflow-preview", "noopener,noreferrer");
    } catch (error) {
      notify(
        "error",
        error instanceof Error ? error.message : "Could not open preview.",
      );
    }
  }
  async function copyRunId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      notify("success", "Run ID copied.");
    } catch {
      notify("error", "Could not copy the run ID.");
    }
  }
  function currentStep(detail: RunDetail) {
    const run = detail.run;
    const savedAgents = detail.executionSnapshot.agents;
    if (!run.currentNode && run.agentId) {
      const agent = savedAgents.find((item) => item.id === run.agentId);
      const label = agent ? `${agent.name} (${run.agentId})` : run.agentId;
      return terminal.has(run.status) ? `Stopped at ${label}` : label;
    }
    if (!run.currentNode)
      return run.status === "cancelled"
        ? "Cancelled"
        : run.status === "failed"
          ? "Failed"
          : "Finished";
    const workflow = detail.executionSnapshot.workflow;
    const node = workflow?.nodes.find((item) => item.id === run.currentNode);
    const agent = savedAgents.find((item) => item.id === node?.agentId);
    const place = node ? `${node.label} (${node.id})` : run.currentNode;
    const label = agent ? `${place} · ${agent.name}` : place;
    return terminal.has(run.status) ? `Stopped at ${label}` : label;
  }
  return (
    <div className="page">
      <PageHead
        eyebrow="Execution"
        title="Runs"
        copy="Start work, watch agent handoffs, and approve the revision you can actually inspect."
      />
      <form
        className={`run-composer ${requiresSource ? "requires-source" : ""}`}
        onSubmit={start}
      >
        <select
          aria-label="Run target"
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setParentRunId("");
          }}
        >
          <option value="">Choose a workflow or agent</option>
          <optgroup label="Workflows">
            {workflows.map((w) => (
              <option key={w.id} value={`w:${w.id}`}>
                {w.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Single agents">
            {agents.map((a) => (
              <option key={a.id} value={`a:${a.id}`}>
                {a.name}
              </option>
            ))}
          </optgroup>
        </select>
        {requiresSource && (
          <select
            aria-label="Approved source application"
            value={parentRunId}
            onChange={(e) => setParentRunId(e.target.value)}
          >
            <option value="">Choose approved source</option>
            {approvedSources.map((run) => (
              <option key={run.id} value={run.id}>
                {runTitle(run.prompt)}
              </option>
            ))}
          </select>
        )}
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            requiresSource
              ? "Describe the change to make"
              : "Describe the application or change"
          }
        />
        <button
          className="primary"
          disabled={
            !target || !prompt.trim() || (requiresSource && !parentRunId)
          }
        >
          <Icon name="runs" /> Start
        </button>
      </form>
      <div className="runs-layout">
        <aside className="run-sidebar">
          {runs.map((run) => (
            <button
              key={run.id}
              className={selectedId === run.id ? "selected" : ""}
              onClick={() => setSelectedId(run.id)}
            >
              <Status status={run.status} />
              <div>
                <strong>{runTitle(run.prompt)}</strong>
                <small>{when(run.updatedAt)}</small>
              </div>
              <Icon name="chevron" />
            </button>
          ))}
          {!runs.length && (
            <Empty compact title="No runs" copy="Send a request above." />
          )}
        </aside>
        <section className="run-detail">
          {detail ? (
            <>
              <div className="run-title">
                <div>
                  <Status status={detail.run.status} />
                  <h2>{runTitle(detail.run.prompt)}</h2>
                  <p className="run-id">
                    Run {detail.run.id} · {detail.run.steps} steps ·{" "}
                    {dollars(detail.run.costUsd)}{" "}
                    <button onClick={() => void copyRunId(detail.run.id)}>
                      Copy ID
                    </button>
                  </p>
                </div>
                <div className="head-actions">
                  {detail.run.status === "failed" && (
                    <button
                      className="secondary"
                      disabled={detail.run.costUsd === null}
                      title={detail.run.costUsd === null ? "Reconcile this run's provider cost before resuming." : "Resume from the retained workflow node and saved setup."}
                      onClick={() => void action(`/runs/${detail.run.id}/resume`)}
                    >
                      <Icon name="runs" /> Resume
                    </button>
                  )}
                  {!terminal.has(detail.run.status) && (
                    <button
                      className="secondary danger"
                      onClick={() =>
                        void action(`/runs/${detail.run.id}/cancel`)
                      }
                    >
                      Cancel
                    </button>
                  )}
                  {detail.run.revisionId && (
                    <>
                      <button
                        className="secondary"
                        onClick={() => void openSource(detail.run.revisionId!)}
                      >
                        <Icon name="code" /> Source
                      </button>
                      <button
                        className="primary"
                        onClick={() => void openPreview(detail.run.revisionId!)}
                      >
                        <Icon name="external" /> Preview
                      </button>
                    </>
                  )}
                </div>
              </div>
              {detail.run.status === "failed" && detail.run.costUsd === null && <p className="resume-blocked">Resume is unavailable until this run's provider cost is reconciled.</p>}
              <div className="run-stats">
                <div>
                  <small>Input tokens</small>
                  <strong>{detail.run.usageIncomplete ? "Unavailable" : detail.run.inputTokens.toLocaleString()}</strong>
                </div>
                <div>
                  <small>Output tokens</small>
                  <strong>{detail.run.usageIncomplete ? "Unavailable" : detail.run.outputTokens.toLocaleString()}</strong>
                </div>
                <div>
                  <small>{["queued", "running"].includes(detail.run.status) ? "Completed-turn cost" : "Reported cost"}</small>
                  <strong>{dollars(detail.run.costUsd)}</strong>
                  {["queued", "running"].includes(detail.run.status) && <em>Current turn usage pending</em>}
                </div>
                <div>
                  <small>Current node</small>
                  <strong>{currentStep(detail)}</strong>
                </div>
              </div>
              {detail.run.usageIncomplete && <div className="usage-note"><strong>Partial usage record</strong><span>{detail.run.usageNote || "Token totals are unavailable for this run. Reported cost is shown when known."}</span></div>}
              {detail.run.costUsd === null && !["queued", "running"].includes(detail.run.status) && (
                <UsageReconciliation
                  onSubmit={(body) => action(`/runs/${detail.run.id}/usage-reconciliation`, body)}
                />
              )}
              <ExecutionSnapshot detail={detail} />
              {detail.run.error && (
                <div className="error-box">
                  <strong>Run stopped</strong>
                  <p>{detail.run.error}</p>
                </div>
              )}
              {detail.run.status === "awaiting_approval" && (
                <div className="approval-box">
                  <span className="eyebrow">Your decision</span>
                  <h3>
                    {detail.approvalKind === "turn"
                      ? "Allow the next agent turn"
                      : "Review this revision"}
                  </h3>
                  <p>
                    {detail.approvalKind === "turn"
                      ? "This agent requires approval before it starts work. Approve the turn, or reject it with instructions."
                      : "Open the preview and source. Approve it for use, or send clear feedback into the revision loop."}
                  </p>
                  <textarea
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder={
                      detail.approvalKind === "turn"
                        ? "Instructions required when rejecting."
                        : "What needs to change? Required when rejecting."
                    }
                  />
                  <div>
                    <button
                      className="secondary danger"
                      disabled={!feedback.trim()}
                      onClick={() =>
                        void action(`/runs/${detail.run.id}/approval`, {
                          approved: false,
                          feedback: feedback.trim(),
                          approvalToken: detail.approvalToken,
                        })
                      }
                    >
                      Reject with feedback
                    </button>
                    <button
                      className="primary"
                      onClick={() =>
                        void action(`/runs/${detail.run.id}/approval`, {
                          approved: true,
                          approvalToken: detail.approvalToken,
                        })
                      }
                    >
                      {detail.approvalKind === "turn"
                        ? "Allow turn"
                        : "Approve revision"}
                    </button>
                  </div>
                </div>
              )}
              {detail.run.status === "completed" && detail.run.revisionId && (
                <div className="complete-box">
                  <span>✓</span>
                  <div>
                    <strong>Approved application ready</strong>
                    <p>
                      Use this revision as the starting point for a focused
                      change.
                    </p>
                  </div>
                  <button
                    className="secondary"
                    onClick={() => void improve(detail.run)}
                  >
                    Improve application
                  </button>
                </div>
              )}
              <Timeline detail={detail} agents={agents} />
            </>
          ) : (
            <Empty
              title="Select a run"
              copy="Its messages, tool activity, revisions, and costs will appear here."
            />
          )}
        </section>
      </div>
      {source && (
        <Modal
          title="Retained source"
          subtitle="Files from this immutable application revision."
          onClose={() => setSource(null)}
          extraWide
        >
          <div className="source-view">
            <aside>
              {source.map((f) => (
                <button
                  className={activeFile === f.path ? "active" : ""}
                  key={f.path}
                  onClick={() => setActiveFile(f.path)}
                >
                  {f.path}
                </button>
              ))}
            </aside>
            <pre>
              <code>
                {source.find((f) => f.path === activeFile)?.content || ""}
              </code>
            </pre>
          </div>
        </Modal>
      )}
    </div>
  );
}

function UsageReconciliation({ onSubmit }: { onSubmit: (body: { totalRunCostUsd: number; inputTokens?: number; outputTokens?: number; note: string }) => Promise<void> }) {
  const [cost, setCost] = useState("");
  const [inputTokens, setInputTokens] = useState("");
  const [outputTokens, setOutputTokens] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const tokensComplete = (!inputTokens && !outputTokens) || (!!inputTokens && !!outputTokens);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!tokensComplete || !cost || !note.trim()) return;
    setSaving(true);
    try {
      await onSubmit({
        totalRunCostUsd: Number(cost),
        ...(inputTokens && outputTokens ? { inputTokens: Number(inputTokens), outputTokens: Number(outputTokens) } : {}),
        note: note.trim(),
      });
    } finally {
      setSaving(false);
    }
  }
  return (
    <details className="usage-reconciliation">
      <summary><strong>Reconcile provider usage</strong><span>Enter values from the provider record</span></summary>
      <form onSubmit={submit}>
        <p>This records usage only. It does not resume the run. Cost is the total for the entire run, including completed turns.</p>
        <div className="form-grid three">
          <Field label="Total run cost (USD)"><input required type="number" min="0" step="any" value={cost} onChange={(event) => setCost(event.target.value)} /></Field>
          <Field label="Input tokens" hint="Optional with output"><input type="number" min="0" step="1" value={inputTokens} onChange={(event) => setInputTokens(event.target.value)} /></Field>
          <Field label="Output tokens" hint="Optional with input"><input type="number" min="0" step="1" value={outputTokens} onChange={(event) => setOutputTokens(event.target.value)} /></Field>
        </div>
        {!tokensComplete && <p className="field-error">Enter both token totals, or leave both empty.</p>}
        <Field label="Provider receipt or provenance note" hint="Required"><textarea required rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Provider record, receipt, or query used to verify these values" /></Field>
        <div className="reconcile-actions"><button className="primary" disabled={saving || !tokensComplete || !cost || !note.trim()}>{saving ? "Recording…" : "Record reconciled usage"}</button></div>
      </form>
    </details>
  );
}

function ExecutionSnapshot({ detail }: { detail: RunDetail }) {
  const { agents, workflow } = detail.executionSnapshot;
  return (
    <details className="execution-snapshot">
      <summary>
        <span>
          <strong>Saved execution setup</strong>
          <small>Immutable configuration captured when this run started</small>
        </span>
        <span>{agents.length} agent{agents.length === 1 ? "" : "s"}</span>
      </summary>
      <div className="snapshot-body">
        <section>
          <h3>Original request</h3>
          <p className="snapshot-prompt">{detail.run.prompt}</p>
        </section>
        {agents.map((agent) => {
          const effectiveTools = agent.tools.filter(
            (tool) => !agent.guardrails.blockedActions.includes(tool),
          );
          return (
            <section className="snapshot-agent" key={agent.id}>
              <header>
                <div><h3>{agent.name}</h3><p>{agent.role}</p></div>
                <code>{agent.id}</code>
              </header>
              <dl className="snapshot-facts">
                <div><dt>Model</dt><dd>{agent.model}</dd></div>
                <div><dt>Approval</dt><dd>{statusLabel(agent.approval)}</dd></div>
                <div><dt>Effective tools</dt><dd>{effectiveTools.join(", ") || "None"}</dd></div>
                <div><dt>Guardrails</dt><dd>${agent.guardrails.maxCostUsd.toFixed(2)} · {agent.guardrails.maxTurns} turns · {agent.guardrails.callsPerHour} calls/hour</dd></div>
                <div><dt>Blocked actions</dt><dd>{agent.guardrails.blockedActions.join(", ") || "None"}</dd></div>
              </dl>
              <div className="snapshot-text"><strong>System prompt</strong><pre>{agent.systemPrompt || "None"}</pre></div>
              <div className="snapshot-columns">
                <div><strong>Memory</strong>{agent.memory.length ? <ul>{agent.memory.map((fact, index) => <li key={index}>{fact}</li>)}</ul> : <p>None</p>}</div>
                <div><strong>Skills</strong>{agent.skills.length ? agent.skills.map((skill, index) => <div className="snapshot-skill" key={`${skill.name}-${index}`}><b>{skill.name}</b><ol>{skill.steps.map((step, stepIndex) => <li key={stepIndex}>{step}</li>)}</ol></div>) : <p>None</p>}</div>
              </div>
            </section>
          );
        })}
        <section>
          <h3>Saved workflow graph</h3>
          {workflow ? <div className="snapshot-graph"><p><strong>{workflow.name}</strong> · entry {workflow.entryNode}{workflow.requiresSource ? " · approved source required" : ""}</p><ul>{workflow.nodes.map(node => <li key={node.id}><b>{node.label}</b> ({node.id}) → {node.agentId}{(node.terminalOutcomes ?? []).length ? ` · ends on: ${node.terminalOutcomes.join(", ")}` : ""}</li>)}</ul><ul>{workflow.edges.map(edge => <li key={edge.id}>{edge.from} <code>{edge.outcome}</code> → {edge.to}</li>)}</ul></div> : <p className="muted">Single-agent run. No workflow graph was used.</p>}
        </section>
      </div>
    </details>
  );
}

function Timeline({ detail, agents }: { detail: RunDetail; agents: Agent[] }) {
  const actor = (id: string) => {
    const scheduledAgentId = id.startsWith("schedule:") ? id.slice(9) : null;
    const addressedId = scheduledAgentId || id;
    const agent = detail.executionSnapshot.agents.find((item) => item.id === addressedId) ?? agents.find((item) => item.id === addressedId);
    const label = agent ? `${agent.name} (${addressedId})` : addressedId;
    return scheduledAgentId ? `Schedule: ${label}` : label;
  };
  type TrailItem = { id: string; at: string; type: string; title: string; content: string; kind: string; output?: string; raw?: string[]; statusRank?: number };
  const { items, technical } = useMemo(() => {
    const visible: TrailItem[] = detail.messages.map((message) => ({
      id: message.id, at: message.createdAt, type: "message",
      title: `${actor(message.from)} → ${actor(message.to)}`,
      content: message.content, kind: message.kind,
    }));
    const hidden: TrailItem[] = [];
    const toolCalls = new Map<string, TrailItem>();
    for (const event of detail.events) {
      if (event.kind !== "tool") {
        visible.push({ id:event.id, at:event.createdAt, type:"event", title:event.kind.replaceAll("_"," "), content:actor(event.content), kind:event.kind });
        continue;
      }
      let envelope: any;
      try { envelope = JSON.parse(event.content); } catch { envelope = null; }
      if (!envelope || typeof envelope !== "object") {
        visible.push({ id:event.id, at:event.createdAt, type:"event", title:"runtime", content:event.content, kind:event.kind });
        continue;
      }
      if (envelope.kind === "status") {
        visible.push({ id:event.id, at:event.createdAt, type:"status", title:"Runtime status", content:String(envelope.content || "Status changed"), kind:"status", raw:[event.content] });
        continue;
      }
      const runtimeType = String(envelope.detail?.type || envelope.content || "runtime event");
      const properties = envelope.detail?.properties;
      const part = properties?.part;
      if (part?.type === "tool") {
        const state = part.state || {};
        const input = state.input && typeof state.input === "object" ? state.input : {};
        const path = input.filePath || input.path || input.pattern || input.query;
        const status = String(state.status || "updated");
        const statusRank = /error|failed/i.test(status) ? 4 : /completed|complete|done/i.test(status) ? 3 : /running/i.test(status) ? 2 : /pending/i.test(status) ? 1 : 0;
        const output = typeof state.output === "string" ? state.output : state.output ? JSON.stringify(state.output, null, 2) : undefined;
        const key = String(part.callID || part.id || event.id);
        const existing = toolCalls.get(key);
        const item: TrailItem = {
          id:`tool-${key}`, at:event.createdAt, type:"tool", title:`${part.tool || "tool"} · ${status}`,
          content:String(state.title || path || "Native tool call"), kind:"tool", output:output || existing?.output,
          raw:[...(existing?.raw || []), event.content], statusRank,
        };
        if (!existing) visible.push(item);
        else if (statusRank >= (existing.statusRank || 0)) Object.assign(existing, item);
        else {
          existing.raw = item.raw;
          if (!existing.output && output) existing.output = output;
        }
        toolCalls.set(key, existing || item);
        continue;
      }
      const runtimeError = properties?.error || envelope.detail?.error;
      if (runtimeError || /error|failed|permission\.asked/i.test(runtimeType)) {
        visible.push({ id:event.id, at:event.createdAt, type:"event", title:runtimeType.replaceAll("."," "), content:typeof runtimeError === "string" ? runtimeError : runtimeError ? JSON.stringify(runtimeError) : "Runtime attention required", kind:"runtime", raw:[event.content] });
        continue;
      }
      hidden.push({ id:event.id, at:event.createdAt, type:"technical", title:runtimeType, content:event.content, kind:"runtime" });
    }
    visible.sort((a,b)=>new Date(a.at).valueOf()-new Date(b.at).valueOf());
    hidden.sort((a,b)=>new Date(a.at).valueOf()-new Date(b.at).valueOf());
    return {items:visible,technical:hidden};
  }, [detail, agents]);
  return (
    <div className="timeline">
      <div className="section-title">
        <div>
          <h3>Live trail</h3>
          <p>Durable messages and runtime events in recorded order.</p>
        </div>
        <span className="live-label">
          <i /> Live
        </span>
      </div>
      {items.length ? (
        items.map((item) => (
          <article key={`${item.type}-${item.id}`}>
            <span className={`timeline-dot ${item.type}`}>
              {item.type === "message" ? "↗" : "·"}
            </span>
            <div>
              <header>
                <strong>{item.title}</strong>
                <time>{when(item.at)}</time>
              </header>
              <p>{item.content}</p>
              {item.output && <details className="tool-output"><summary>Tool output</summary><pre>{item.output}</pre></details>}
              {item.raw && <details className="raw-event"><summary>Raw event{item.raw.length > 1 ? `s (${item.raw.length})` : ""}</summary>{item.raw.map((raw,index)=><pre key={index}>{raw}</pre>)}</details>}
              <small>{item.kind}</small>
            </div>
          </article>
        ))
      ) : !technical.length ? (
        <Empty
          compact
          title="Waiting for activity"
          copy="Runtime events will appear here as the run advances."
        />
      ) : null}
      {technical.length > 0 && <details className="technical-events"><summary>{technical.length} technical event{technical.length===1?"":"s"} · protocol, catalog, and message updates</summary><div>{technical.map(item=><article key={item.id}><header><strong>{item.title}</strong><time>{when(item.at)}</time></header><pre>{item.content}</pre></article>)}</div></details>}
    </div>
  );
}

function Status({ status }: { status: string }) {
  return (
    <span className={`status ${status}`}>
      <i />
      {statusLabel(status)}
    </span>
  );
}

function Setup({
  settings,
  agents,
}: {
  settings: Settings | null;
  agents: Agent[];
}) {
  return (
    <div className="page">
      <PageHead
        eyebrow="Local setup"
        title="Connections"
        copy="Credentials stay in the server environment. OrbitFlow only reports whether each integration is ready."
      />
      {settings ? (
        <div className="setup-grid">
          <section className="panel setup-hero">
            <span
              className={`large-state ${paidSetupReady(settings) ? "ok" : ""}`}
            >
              {paidSetupReady(settings)
                ? "✓"
                : "!"}
            </span>
            <h2>
              {paidSetupReady(settings)
                ? "Core services are ready"
                : "Configuration needed"}
            </h2>
            <p>The UI never reads or stores provider or Telegram secrets.</p>
            <div className="budget">
              <div>
                <span>Provider spend</span>
                <strong>{dollars(settings.spentUsd)}</strong>
              </div>
              <div className="meter">
                <span
                  style={{
                    width: `${Math.min(100, settings.budgetUsd ? (settings.spentUsd / settings.budgetUsd) * 100 : 0)}%`,
                  }}
                />
              </div>
              <small>${settings.budgetUsd.toFixed(2)} authorized limit</small>
              {(settings.unknownCostRuns ?? 0) > 0 && (
                <div className="cost-warning">
                  <strong>Usage cost unresolved</strong>
                  <span>
                    {settings.unknownCostRuns} run
                    {settings.unknownCostRuns === 1 ? " has" : "s have"} unknown
                    provider cost. The displayed spend is the known subtotal,
                    and paid work is paused.
                  </span>
                </div>
              )}
            </div>
          </section>
          <section className="panel connection-list">
            <Connection
              ok={settings.databaseReady}
              name="PostgreSQL"
              detail="Agent state, messages, and revisions"
              command="docker compose up -d postgres"
            />
            <Connection
              ok={paidSetupReady(settings)}
              name={settings.runtime}
              detail={`Pinned runtime ${settings.runtimeVersion}`}
              command="Set the provider key and budget in .env"
            />
            <Connection
              ok={settings.telegramConfigured}
              name="Telegram"
              detail={
                settings.telegramUsername
                  ? `Connected as @${settings.telegramUsername}`
                  : "External conversation channel"
              }
              command="Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env"
            />
          </section>
        </div>
      ) : (
        <Empty
          title="Settings unavailable"
          copy="Start the local server to inspect integration readiness."
        />
      )}
      <section className="panel channel-agents">
        <div className="panel-title">
          <div>
            <span className="eyebrow">Routing</span>
            <h2>Telegram agents</h2>
          </div>
          <span>{agents.filter((a) => a.telegram).length} connected</span>
        </div>
        {agents.filter((a) => a.telegram).length ? (
          <div className="simple-agent-list">
            {agents
              .filter((a) => a.telegram)
              .map((a) => (
                <div key={a.id}>
                  <Avatar name={a.name} />
                  <div>
                    <strong>{a.name}</strong>
                    <small>
                      {a.role} · {a.model}
                    </small>
                  </div>
                  <span className="status completed">
                    <i /> Enabled
                  </span>
                </div>
              ))}
          </div>
        ) : (
          <p className="muted">
            Enable Telegram on an agent to route bot conversations through its
            real configuration.
          </p>
        )}
      </section>
    </div>
  );
}

function Connection({
  ok,
  name,
  detail,
  command,
}: {
  ok: boolean;
  name: string;
  detail: string;
  command: string;
}) {
  return (
    <div className="connection">
      <span className={ok ? "check ok" : "check"}>{ok ? "✓" : "!"}</span>
      <div>
        <strong>{name}</strong>
        <small>{detail}</small>
        <code>{command}</code>
      </div>
      <span className={`state-label ${ok ? "ready" : ""}`}>
        {ok ? "Ready" : "Action needed"}
      </span>
    </div>
  );
}

function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide,
  extraWide,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  extraWide?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        className={`modal ${wide ? "wide" : ""} ${extraWide ? "extra-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.stopPropagation();
            onClose();
          }
          if (event.key !== "Tab" || event.defaultPrevented) return;
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
            ),
          ).filter((element) => element.getClientRects().length > 0);
          const first = items[0],
            last = items.at(-1);
          if (
            event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === dialog.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header>
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function Empty({
  title,
  copy,
  action,
  compact,
}: {
  title: string;
  copy: string;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty ${compact ? "compact" : ""}`}>
      <span className="empty-orbit">
        <i />
      </span>
      <h3>{title}</h3>
      <p>{copy}</p>
      {action}
    </div>
  );
}
