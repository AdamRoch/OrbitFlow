"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { AgentDTO, JsonObject, ScheduleDTO, SkillDTO } from "@/lib/control-plane/types";
import { AlienIcon, CheckIcon, CometIcon, RadarIcon, SignalIcon, UfoIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";

type EditorForm = {
  name: string;
  role: string;
  systemPrompt: string;
  model: string;
  codingToolEnabled: boolean;
  costLimit: string;
  rateLimit: string;
  blockedActions: string;
  mayAnswerQuestions: boolean;
  autonomy: string;
  channelProvider: string;
  channelChatId: string;
  openclawRef: string;
  facts: string[];
  guardrailsAdvanced: string;
  interactionRulesAdvanced: string;
  channelBindingAdvanced: string;
  memoryAdvanced: string;
};

type ScheduleForm = { cronExpression: string; taskPrompt: string; enabled: boolean };
type PendingDelete = { kind: "agent"; id: string; name: string } | { kind: "schedule"; id: string; name: string };

const templates = [
  {
    id: "orchestrator",
    name: "Orchestrator",
    role: "orchestrator",
    model: "openrouter/openai/gpt-4.1-mini",
    prompt: "Coordinate the work, preserve the human's intent, and make the next useful decision explicit.",
  },
  {
    id: "implementer",
    name: "Implementer",
    role: "software engineer",
    model: "openrouter/anthropic/claude-sonnet-4",
    prompt: "Implement the assigned change carefully, validate the behavior, and report concrete evidence and remaining risks.",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role: "reviewer",
    model: "openrouter/openai/gpt-4.1-mini",
    prompt: "Review the proposed work against its contract. Identify real defects, explain impact, and suggest the smallest correction.",
  },
] as const;

const blankSchedule = (): ScheduleForm => ({ cronExpression: "0 9 * * 1-5", taskPrompt: "", enabled: true });

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function factsFromMemory(memory: JsonObject): string[] {
  return Array.isArray(memory.facts) ? memory.facts.filter((fact): fact is string => typeof fact === "string") : [];
}

function withoutKeys(value: JsonObject, keys: string[]): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function formFromAgent(agent?: AgentDTO): EditorForm {
  if (!agent) {
    return {
      name: "", role: "", systemPrompt: "", model: templates[0].model, codingToolEnabled: false,
      costLimit: "", rateLimit: "", blockedActions: "", mayAnswerQuestions: false, autonomy: "",
      channelProvider: "", channelChatId: "", openclawRef: "", facts: [],
      guardrailsAdvanced: "{}", interactionRulesAdvanced: "{}", channelBindingAdvanced: "{}", memoryAdvanced: "{}",
    };
  }
  const guardrails = object(agent.guardrails);
  const rateLimit = object(guardrails.rateLimit);
  const rules = object(agent.interactionRules);
  const channel = object(agent.channelBinding);
  const memory = object(agent.memory);
  return {
    name: agent.name,
    role: agent.role,
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    codingToolEnabled: agent.codingToolEnabled,
    costLimit: guardrails.costLimit === undefined ? "" : String(guardrails.costLimit),
    rateLimit: rateLimit.perMinute === undefined ? "" : String(rateLimit.perMinute),
    blockedActions: Array.isArray(guardrails.blockedActions) ? guardrails.blockedActions.filter((item): item is string => typeof item === "string").join("\n") : "",
    mayAnswerQuestions: rules.mayAnswerQuestions === true,
    autonomy: stringValue(rules.autonomy),
    channelProvider: stringValue(channel.provider),
    channelChatId: stringValue(channel.chatId),
    openclawRef: agent.openclawRef ?? "",
    facts: factsFromMemory(memory),
    guardrailsAdvanced: JSON.stringify(withoutKeys(guardrails, ["costLimit", "rateLimit", "blockedActions"]), null, 2),
    interactionRulesAdvanced: JSON.stringify(withoutKeys(rules, ["mayAnswerQuestions", "autonomy"]), null, 2),
    channelBindingAdvanced: JSON.stringify(withoutKeys(channel, ["provider", "chatId"]), null, 2),
    memoryAdvanced: JSON.stringify(withoutKeys(memory, ["facts"]), null, 2),
  };
}

function parseObject(text: string, field: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as JsonObject;
  } catch {
    throw new Error(`${field} must be a JSON object.`);
  }
}

function payloadFromForm(form: EditorForm) {
  const guardrails = parseObject(form.guardrailsAdvanced, "Guardrail details");
  const interactionRules = parseObject(form.interactionRulesAdvanced, "Interaction-rule details");
  const channelExtras = parseObject(form.channelBindingAdvanced, "Channel details");
  const memory = parseObject(form.memoryAdvanced, "Memory details");
  const costLimit = Number(form.costLimit);
  const rateLimit = Number(form.rateLimit);

  if (form.costLimit.trim()) {
    if (!Number.isFinite(costLimit) || costLimit < 0) throw new Error("Cost ceiling must be a non-negative number.");
    guardrails.costLimit = costLimit;
  }
  if (form.rateLimit.trim()) {
    if (!Number.isFinite(rateLimit) || rateLimit < 0) throw new Error("Rate limit must be a non-negative number.");
    guardrails.rateLimit = { ...object(guardrails.rateLimit), perMinute: rateLimit };
  }
  guardrails.blockedActions = form.blockedActions.split("\n").map((action) => action.trim()).filter(Boolean);
  interactionRules.mayAnswerQuestions = form.mayAnswerQuestions;
  if (form.autonomy.trim()) interactionRules.autonomy = form.autonomy.trim();
  else delete interactionRules.autonomy;
  memory.facts = form.facts.map((fact) => fact.trim()).filter(Boolean);

  const channelBinding = form.channelProvider.trim() || form.channelChatId.trim() || Object.keys(channelExtras).length
    ? { ...channelExtras, ...(form.channelProvider.trim() ? { provider: form.channelProvider.trim() } : {}), ...(form.channelChatId.trim() ? { chatId: form.channelChatId.trim() } : {}) }
    : null;
  return {
    name: form.name.trim(), role: form.role.trim(), systemPrompt: form.systemPrompt.trim(), model: form.model.trim(),
    codingToolEnabled: form.codingToolEnabled, guardrails, interactionRules, channelBinding, memory,
    openclawRef: form.openclawRef.trim() || null,
  };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (response.status === 204) return undefined as T;
  const body = await response.json() as T | { error?: { message?: string; code?: string | null } };
  if (!response.ok) {
    const error = body as { error?: { message?: string; code?: string | null } };
    const detail = error.error?.message ?? "The control plane did not accept this change.";
    const failure = new Error(detail) as Error & { code?: string | null };
    failure.code = error.error?.code;
    throw failure;
  }
  return body as T;
}

export function AgentEditor() {
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [skills, setSkills] = useState<SkillDTO[]>([]);
  const [schedules, setSchedules] = useState<ScheduleDTO[]>([]);
  const [selected, setSelected] = useState<AgentDTO | null>(null);
  const [form, setForm] = useState<EditorForm>(() => formFromAgent());
  const [scheduleForm, setScheduleForm] = useState<ScheduleForm>(blankSchedule);
  const [editingSchedule, setEditingSchedule] = useState<ScheduleDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  const load = useCallback(async (agentId?: string) => {
    setLoading(true);
    setError("");
    try {
      const [nextAgents, nextSkills] = await Promise.all([request<AgentDTO[]>("/api/agents"), request<SkillDTO[]>("/api/skills")]);
      setAgents(nextAgents);
      setSkills(nextSkills);
      const nextSelected = agentId ? nextAgents.find((agent) => agent.id === agentId) ?? null : null;
      setSelected(nextSelected);
      setForm(formFromAgent(nextSelected ?? undefined));
      setSchedules(nextSelected ? await request<ScheduleDTO[]>(`/api/agents/${nextSelected.id}/schedules`) : []);
      setStale(false);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load agents from PostgreSQL.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selectAgent = async (agent: AgentDTO) => {
    setSelected(agent);
    setForm(formFromAgent(agent));
    setSchedules([]);
    setError("");
    setMessage("");
    setStale(false);
    try {
      setSchedules(await request<ScheduleDTO[]>(`/api/agents/${agent.id}/schedules`));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load schedules.");
    }
  };

  const newAgent = () => {
    setSelected(null); setForm(formFromAgent()); setSchedules([]); setEditingSchedule(null); setMessage(""); setError(""); setStale(false);
  };

  const applyTemplate = (templateId: string) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    setForm((current) => ({ ...current, name: current.name || template.name, role: template.role, model: template.model, systemPrompt: template.prompt }));
  };

  const submitAgent = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(""); setMessage("");
    try {
      const body = payloadFromForm(form);
      if (!body.name || !body.role || !body.systemPrompt || !body.model) throw new Error("Name, role, system prompt, and model are required.");
      const agent = selected
        ? await request<AgentDTO>(`/api/agents/${selected.id}`, { method: "PATCH", body: JSON.stringify({ ...body, expectedUpdatedAt: selected.updatedAt }) })
        : await request<AgentDTO>("/api/agents", { method: "POST", body: JSON.stringify(body) });
      await load(agent.id);
      setMessage(selected ? "Agent changes saved to PostgreSQL." : "Agent created in PostgreSQL. Attach skills and add a schedule below.");
    } catch (saveError) {
      const requestError = saveError as Error & { code?: string | null };
      setStale(requestError.code === "stale_update");
      setError(requestError.code === "stale_update" ? "This agent changed elsewhere. Refresh it before saving again; your draft is still visible." : requestError.message);
    } finally { setSaving(false); }
  };

  const toggleSkill = async (skill: SkillDTO, attached: boolean) => {
    if (!selected) return;
    setError(""); setMessage("");
    try {
      await request<void>(`/api/agents/${selected.id}/skills/${skill.id}`, { method: attached ? "DELETE" : "PUT" });
      const agent = await request<AgentDTO>(`/api/agents/${selected.id}`);
      setSelected(agent); setAgents((current) => current.map((item) => item.id === agent.id ? agent : item));
      setMessage(attached ? `${skill.name} detached.` : `${skill.name} attached.`);
    } catch (skillError) { setError(skillError instanceof Error ? skillError.message : "Unable to update skill attachment."); }
  };

  const submitSchedule = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true); setError(""); setMessage("");
    try {
      if (!scheduleForm.cronExpression.trim() || !scheduleForm.taskPrompt.trim()) throw new Error("Cron expression and standing task are required.");
      const saved = editingSchedule
        ? await request<ScheduleDTO>(`/api/schedules/${editingSchedule.id}`, { method: "PATCH", body: JSON.stringify({ ...scheduleForm, expectedUpdatedAt: editingSchedule.updatedAt }) })
        : await request<ScheduleDTO>(`/api/agents/${selected.id}/schedules`, { method: "POST", body: JSON.stringify(scheduleForm) });
      setSchedules((current) => editingSchedule ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved]);
      setScheduleForm(blankSchedule()); setEditingSchedule(null); setMessage(editingSchedule ? "Schedule association updated." : "Schedule association created. Execution remains disabled until FACT-25.");
    } catch (scheduleError) {
      const requestError = scheduleError as Error & { code?: string | null };
      setStale(requestError.code === "stale_update");
      setError(requestError.code === "stale_update" ? "This schedule changed elsewhere. Refresh the agent before saving again." : requestError.message);
    } finally { setSaving(false); }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setSaving(true); setError("");
    try {
      if (pendingDelete.kind === "agent") {
        await request<void>(`/api/agents/${pendingDelete.id}`, { method: "DELETE" });
        newAgent(); await load(); setMessage("Agent deleted.");
      } else {
        await request<void>(`/api/schedules/${pendingDelete.id}`, { method: "DELETE" });
        setSchedules((current) => current.filter((item) => item.id !== pendingDelete.id));
        setMessage("Schedule association deleted.");
      }
      setPendingDelete(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete this record."); setPendingDelete(null);
    } finally { setSaving(false); }
  };

  const attachedSkillIds = useMemo(() => new Set(selected?.skills.map((skill) => skill.id)), [selected]);
  const setField = <K extends keyof EditorForm>(field: K, value: EditorForm[K]) => setForm((current) => ({ ...current, [field]: value }));

  return (
    <div className="min-w-0">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="eyebrow"><UfoIcon className="h-3 w-3" /> Control plane</span>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[--foreground] text-glow">Agents</h1>
          <p className="mt-1 max-w-2xl text-sm text-[--foreground-muted]">Configure who does the work. Every saved setting is read from and written to the PostgreSQL control plane.</p>
        </div>
        <Button variant="primary" onClick={newAgent} icon={<CometIcon className="h-3.5 w-3.5" />}>New agent</Button>
      </div>

      {message && <p role="status" className="mb-4 rounded-xl border border-[--success]/40 bg-[--success]/10 px-3 py-2 text-sm text-[--success]">{message}</p>}
      {error && <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[--danger]/45 bg-[--danger]/10 px-3 py-2 text-sm text-[--danger]"><span>{error}</span>{stale && <Button size="sm" onClick={() => void load(selected?.id)}>Refresh current record</Button>}</div>}

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(15rem,0.75fr)_minmax(0,1.75fr)]">
        <aside className="glass rounded-2xl p-2 lg:self-start">
          <div className="flex items-center justify-between px-2 py-2"><span className="text-xs font-medium uppercase tracking-[0.16em] text-[--foreground-subtle]">Roster</span><Badge>{agents.length}</Badge></div>
          {loading ? <p className="px-3 py-8 text-sm text-[--foreground-muted]">Loading agents…</p> : agents.length === 0 ? (
            <div className="px-3 py-8 text-center"><AlienIcon className="mx-auto h-8 w-8 text-[--foreground-subtle]" /><p className="mt-3 text-sm text-[--foreground-muted]">No agents yet.</p><p className="mt-1 text-xs text-[--foreground-subtle]">Start with an opinionated template, then make it yours.</p></div>
          ) : <div className="space-y-1">{agents.map((agent) => <button key={agent.id} type="button" onClick={() => void selectAgent(agent)} className={`w-full min-w-0 rounded-xl px-3 py-3 text-left transition-colors ${selected?.id === agent.id ? "bg-[--surface-hover] ring-1 ring-[--accent]/50" : "hover:bg-[--surface-hover]"}`}><span className="block truncate text-sm font-medium text-[--foreground]">{agent.name}</span><span className="mt-0.5 block truncate text-xs text-[--foreground-muted]">{agent.role} · {agent.model}</span></button>)}</div>}
        </aside>

        <div className="glass min-w-0 rounded-2xl p-4 sm:p-6">
          <form onSubmit={(event) => void submitAgent(event)}>
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold text-[--foreground]">{selected ? `Edit ${selected.name}` : "Create an agent"}</h2><p className="mt-1 text-xs text-[--foreground-muted]">{selected ? "Changes use the version you opened; stale updates never overwrite another editor." : "Templates are starting points. Their prompts remain editable."}</p></div>{selected && <Button variant="danger" size="sm" onClick={() => setPendingDelete({ kind: "agent", id: selected.id, name: selected.name })}>Delete agent</Button>}</div>

          {!selected && <div className="mb-5"><Label htmlFor="agent-template">Start from a template</Label><Select id="agent-template" defaultValue="" onChange={(event) => applyTemplate(event.target.value)}><option value="">Choose a starting point</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.role}</option>)}</Select></div>}
          <section className="grid min-w-0 gap-4 sm:grid-cols-2"><Field label="Name" htmlFor="agent-name"><Input id="agent-name" value={form.name} onChange={(event) => setField("name", event.target.value)} required /></Field><Field label="Role" htmlFor="agent-role"><Input id="agent-role" value={form.role} onChange={(event) => setField("role", event.target.value)} required /></Field><Field label="Model" htmlFor="agent-model"><Input id="agent-model" value={form.model} onChange={(event) => setField("model", event.target.value)} required /></Field><Field label="OpenClaw reference" htmlFor="agent-openclaw"><Input id="agent-openclaw" value={form.openclawRef} onChange={(event) => setField("openclawRef", event.target.value)} placeholder="Optional external runtime id" /></Field></section>
          <div className="mt-4"><Field label="System prompt" htmlFor="agent-prompt"><Textarea id="agent-prompt" value={form.systemPrompt} onChange={(event) => setField("systemPrompt", event.target.value)} required /></Field></div>
          <p className="mt-2 rounded-xl border border-[--border] bg-[--surface-2]/40 p-3 text-xs leading-relaxed text-[--foreground-muted]"><strong className="text-[--foreground]">Fixed runtime contract.</strong> Structured output, platform tool surface, and message types are applied by the runtime and are not editable here.</p>

          <Section title="Tools and channel" icon={<SignalIcon className="h-4 w-4" />}><label className="flex items-center gap-3 rounded-xl border border-[--border] bg-[--surface-2]/35 p-3 text-sm text-[--foreground]"><input type="checkbox" checked={form.codingToolEnabled} onChange={(event) => setField("codingToolEnabled", event.target.checked)} className="h-4 w-4 accent-[--accent]" /> Enable coding-tool access</label><div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2"><Field label="Channel provider" htmlFor="channel-provider"><Input id="channel-provider" value={form.channelProvider} onChange={(event) => setField("channelProvider", event.target.value)} placeholder="telegram" /></Field><Field label="Channel chat / destination" htmlFor="channel-chat"><Input id="channel-chat" value={form.channelChatId} onChange={(event) => setField("channelChatId", event.target.value)} placeholder="42" /></Field></div><Advanced label="Additional channel fields" id="channel-advanced" value={form.channelBindingAdvanced} onChange={(value) => setField("channelBindingAdvanced", value)} description="Optional JSON object for binding details not covered by provider and destination." /></Section>

          <Section title="Interaction rules" icon={<RadarIcon className="h-4 w-4" />}><div className="grid min-w-0 gap-4 sm:grid-cols-2"><label className="flex items-center gap-3 rounded-xl border border-[--border] bg-[--surface-2]/35 p-3 text-sm text-[--foreground]"><input type="checkbox" checked={form.mayAnswerQuestions} onChange={(event) => setField("mayAnswerQuestions", event.target.checked)} className="h-4 w-4 accent-[--accent]" /> May answer questions</label><Field label="Autonomy level" htmlFor="agent-autonomy"><Input id="agent-autonomy" value={form.autonomy} onChange={(event) => setField("autonomy", event.target.value)} placeholder="ask-before-risk" /></Field></div><Advanced label="Additional interaction rules" id="interaction-advanced" value={form.interactionRulesAdvanced} onChange={(value) => setField("interactionRulesAdvanced", value)} description="Only use this for an existing persisted rule without a clear control above." /></Section>

          <Section title="Guardrails" icon={<CheckIcon className="h-4 w-4" />}><div className="grid min-w-0 gap-4 sm:grid-cols-2"><Field label="Cost ceiling" htmlFor="cost-limit"><Input id="cost-limit" type="number" min="0" step="any" value={form.costLimit} onChange={(event) => setField("costLimit", event.target.value)} placeholder="12.50" /></Field><Field label="Rate limit per minute" htmlFor="rate-limit"><Input id="rate-limit" type="number" min="0" step="1" value={form.rateLimit} onChange={(event) => setField("rateLimit", event.target.value)} placeholder="8" /></Field></div><div className="mt-4"><Field label="Blocked actions" htmlFor="blocked-actions"><Textarea id="blocked-actions" className="min-h-24" value={form.blockedActions} onChange={(event) => setField("blockedActions", event.target.value)} placeholder={"deploy-production\ndelete-workspace"} /></Field><p className="mt-1 text-xs text-[--foreground-subtle]">One action per line. Enforcement is intentionally deferred to FACT-25.</p></div><Advanced label="Additional guardrail fields" id="guardrails-advanced" value={form.guardrailsAdvanced} onChange={(value) => setField("guardrailsAdvanced", value)} description="Optional JSON object for persisted guardrail details without a clearer field." /></Section>

          <Section title="Memory facts" icon={<AlienIcon className="h-4 w-4" />}><p className="mb-3 text-xs text-[--foreground-muted]">Facts are stored canonically in this agent’s <code className="text-[--accent]">memory.facts</code> field.</p><div className="space-y-2">{form.facts.map((fact, index) => <div key={index} className="flex min-w-0 gap-2"><Input aria-label={`Memory fact ${index + 1}`} value={fact} onChange={(event) => setField("facts", form.facts.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} /><Button variant="danger" size="sm" aria-label={`Delete memory fact ${index + 1}`} onClick={() => setField("facts", form.facts.filter((_, itemIndex) => itemIndex !== index))}>Remove</Button></div>)}</div><Button className="mt-3" size="sm" onClick={() => setField("facts", [...form.facts, ""])}>Add fact</Button><Advanced label="Additional memory details" id="memory-advanced" value={form.memoryAdvanced} onChange={(value) => setField("memoryAdvanced", value)} description="Optional JSON object for canonical memory details beyond individual facts." /></Section>

          <div className="mt-7 flex flex-wrap justify-end gap-3"><Button type="submit" variant="primary" disabled={saving}>{saving ? "Saving…" : selected ? "Save changes" : "Create agent"}</Button></div>
          </form>

          {selected && <section className="mt-8 border-t border-[--border] pt-6"><h3 className="flex items-center gap-2 text-base font-semibold text-[--foreground]"><UfoIcon className="h-4 w-4 text-[--accent]" /> Attached skills</h3><p className="mt-1 text-xs text-[--foreground-muted]">Attachments use the FACT-8 skill endpoints; skill definitions remain managed by the control plane.</p><div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">{skills.length === 0 ? <p className="text-sm text-[--foreground-muted]">No skills exist yet.</p> : skills.map((skill) => { const attached = attachedSkillIds.has(skill.id); return <button key={skill.id} type="button" aria-pressed={attached} onClick={() => void toggleSkill(skill, attached)} className={`min-w-0 rounded-xl border p-3 text-left text-sm transition-colors ${attached ? "border-[--accent]/50 bg-[--accent]/10" : "border-[--border] bg-[--surface-2]/35 hover:bg-[--surface-hover]"}`}><span className="block truncate font-medium text-[--foreground]">{skill.name}</span><span className="mt-1 block truncate text-xs text-[--foreground-muted]">{attached ? "Attached · click to detach" : "Click to attach"}</span></button>; })}</div></section>}

          {selected && <section className="mt-8 border-t border-[--border] pt-6"><h3 className="flex items-center gap-2 text-base font-semibold text-[--foreground]"><CometIcon className="h-4 w-4 text-[--accent]" /> Schedule associations</h3><p className="mt-1 text-xs text-[--foreground-muted]">Persisted standing tasks only. Cron execution and hot enable/disable behavior belong to FACT-25.</p><div className="mt-3 space-y-2">{schedules.length === 0 ? <p className="rounded-xl border border-dashed border-[--border] p-3 text-sm text-[--foreground-muted]">No schedules are associated with this agent.</p> : schedules.map((schedule) => <div key={schedule.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-[--border] bg-[--surface-2]/35 p-3"><div className="min-w-0"><p className="truncate font-mono text-xs text-[--accent]">{schedule.cronExpression}</p><p className="mt-1 truncate text-sm text-[--foreground]">{schedule.taskPrompt}</p><p className="mt-1 text-xs text-[--foreground-muted]">{schedule.enabled ? "Persisted as enabled" : "Persisted as disabled"}</p></div><div className="flex gap-2"><Button size="sm" onClick={() => { setEditingSchedule(schedule); setScheduleForm({ cronExpression: schedule.cronExpression, taskPrompt: schedule.taskPrompt ?? "", enabled: schedule.enabled }); }}>Edit</Button><Button variant="danger" size="sm" onClick={() => setPendingDelete({ kind: "schedule", id: schedule.id, name: schedule.taskPrompt ?? schedule.cronExpression })}>Delete</Button></div></div>)}</div><form onSubmit={(event) => void submitSchedule(event)} className="mt-4 rounded-xl border border-[--border] bg-[--surface-2]/25 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium text-[--foreground]">{editingSchedule ? "Edit schedule" : "Add schedule"}</h4>{editingSchedule && <Button size="sm" onClick={() => { setEditingSchedule(null); setScheduleForm(blankSchedule()); }}>Cancel edit</Button>}</div><div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2"><Field label="Cron expression" htmlFor="schedule-cron"><Input id="schedule-cron" value={scheduleForm.cronExpression} onChange={(event) => setScheduleForm((current) => ({ ...current, cronExpression: event.target.value }))} required /></Field><label className="flex items-end gap-2 pb-2 text-sm text-[--foreground]"><input type="checkbox" checked={scheduleForm.enabled} onChange={(event) => setScheduleForm((current) => ({ ...current, enabled: event.target.checked }))} className="h-4 w-4 accent-[--accent]" /> Persist as enabled</label></div><div className="mt-3"><Field label="Standing task" htmlFor="schedule-task"><Textarea id="schedule-task" className="min-h-24" value={scheduleForm.taskPrompt} onChange={(event) => setScheduleForm((current) => ({ ...current, taskPrompt: event.target.value }))} required /></Field></div><Button className="mt-3" type="submit" size="sm" disabled={saving}>{editingSchedule ? "Save schedule" : "Add schedule"}</Button></form></section>}
        </div>
      </div>

      {pendingDelete && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"><div role="alertdialog" aria-modal="true" aria-labelledby="delete-title" className="glass w-full max-w-md rounded-2xl p-5 shadow-2xl"><h2 id="delete-title" className="text-lg font-semibold text-[--foreground]">Delete {pendingDelete.kind === "agent" ? "agent" : "schedule"}?</h2><p className="mt-2 text-sm text-[--foreground-muted]">{pendingDelete.kind === "agent" ? `Delete ${pendingDelete.name}? Existing schedule associations must be removed first.` : `Delete the schedule for “${pendingDelete.name}”? This cannot be undone.`}</p><div className="mt-5 flex justify-end gap-3"><Button autoFocus onClick={() => setPendingDelete(null)}>Cancel</Button><Button variant="danger" onClick={() => void confirmDelete()} disabled={saving}>Delete</Button></div></div></div>}
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return <div className="min-w-0"><Label htmlFor={htmlFor}>{label}</Label>{children}</div>;
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return <section className="mt-7 border-t border-[--border] pt-6"><h3 className="flex items-center gap-2 text-base font-semibold text-[--foreground]"><span className="text-[--accent]">{icon}</span>{title}</h3><div className="mt-3">{children}</div></section>;
}

function Advanced({ label, id, value, onChange, description }: { label: string; id: string; value: string; onChange: (value: string) => void; description: string }) {
  return <details className="mt-4 rounded-xl border border-[--border] bg-[--surface-2]/20 p-3"><summary className="cursor-pointer text-xs font-medium text-[--foreground-muted]">{label}</summary><p className="mt-2 text-xs text-[--foreground-subtle]">{description}</p><Label className="mt-3" htmlFor={id}>JSON object</Label><Textarea id={id} className="min-h-28 font-mono text-xs" value={value} onChange={(event) => onChange(event.target.value)} /></details>;
}
