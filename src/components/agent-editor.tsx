"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  isExisting: boolean;
  guardrailsOriginal: JsonObject;
  interactionRulesOriginal: JsonObject;
  channelBindingOriginal: JsonObject;
  memoryOriginal: JsonObject;
  costLimitTouched: boolean;
  rateLimitTouched: boolean;
  blockedActionsTouched: boolean;
  mayAnswerQuestionsTouched: boolean;
  autonomyTouched: boolean;
  channelProviderTouched: boolean;
  channelChatIdTouched: boolean;
  factsTouched: boolean;
};

type ScheduleForm = { cronExpression: string; taskPrompt: string; enabled: boolean };
type PendingDelete = { kind: "agent"; id: string; name: string } | { kind: "schedule"; id: string; name: string };
type ScheduleTriggerResult =
  | { kind: "created" | "duplicate"; scheduleId: string; tickKey: string; runId: string; messageId: string }
  | { kind: "disabled"; scheduleId: string };
type ScheduleTriggerState =
  | { kind: "created" | "duplicate"; runId: string }
  | { kind: "disabled" }
  | { kind: "error"; message: string };

const templates = (model: string) => [
  {
    id: "orchestrator",
    name: "Orchestrator",
    role: "orchestrator",
    model,
    prompt: "Coordinate the work, preserve the human's intent, and make the next useful decision explicit.",
  },
  {
    id: "implementer",
    name: "Implementer",
    role: "software engineer",
    model,
    prompt: "Implement the assigned change carefully, validate the behavior, and report concrete evidence and remaining risks.",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role: "reviewer",
    model,
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

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function factsFromMemory(memory: JsonObject): string[] {
  return Array.isArray(memory.facts) ? memory.facts.filter((fact): fact is string => typeof fact === "string") : [];
}

function withoutKeys(value: JsonObject, keys: string[]): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function formFromAgent(primaryModel: string, agent?: AgentDTO): EditorForm {
  if (!agent) {
    return {
      name: "", role: "", systemPrompt: "", model: primaryModel, codingToolEnabled: false,
      costLimit: "", rateLimit: "", blockedActions: "", mayAnswerQuestions: false, autonomy: "",
      channelProvider: "", channelChatId: "", openclawRef: "", facts: [],
      guardrailsAdvanced: "{}", interactionRulesAdvanced: "{}", channelBindingAdvanced: "{}", memoryAdvanced: "{}",
      isExisting: false, guardrailsOriginal: {}, interactionRulesOriginal: {}, channelBindingOriginal: {}, memoryOriginal: {},
      costLimitTouched: false, rateLimitTouched: false, blockedActionsTouched: false, mayAnswerQuestionsTouched: false,
      autonomyTouched: false, channelProviderTouched: false, channelChatIdTouched: false, factsTouched: false,
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
    costLimit: finiteNumber(guardrails.costLimit) ? String(guardrails.costLimit) : "",
    rateLimit: finiteNumber(rateLimit.perMinute) ? String(rateLimit.perMinute) : "",
    blockedActions: stringArray(guardrails.blockedActions) ? guardrails.blockedActions.join("\n") : "",
    mayAnswerQuestions: rules.mayAnswerQuestions === true,
    autonomy: stringValue(rules.autonomy),
    channelProvider: stringValue(channel.provider),
    channelChatId: stringValue(channel.chatId),
    openclawRef: agent.openclawRef ?? "",
    facts: stringArray(memory.facts) ? factsFromMemory(memory) : [],
    guardrailsAdvanced: JSON.stringify(withoutKeys(guardrails, [
      ...(finiteNumber(guardrails.costLimit) ? ["costLimit"] : []),
      ...(finiteNumber(rateLimit.perMinute) ? ["rateLimit"] : []),
      ...(stringArray(guardrails.blockedActions) ? ["blockedActions"] : []),
    ]), null, 2),
    interactionRulesAdvanced: JSON.stringify(withoutKeys(rules, [
      ...(typeof rules.mayAnswerQuestions === "boolean" ? ["mayAnswerQuestions"] : []),
      ...(typeof rules.autonomy === "string" ? ["autonomy"] : []),
    ]), null, 2),
    channelBindingAdvanced: JSON.stringify(withoutKeys(channel, [
      ...(typeof channel.provider === "string" ? ["provider"] : []),
      ...(typeof channel.chatId === "string" ? ["chatId"] : []),
    ]), null, 2),
    memoryAdvanced: JSON.stringify(withoutKeys(memory, stringArray(memory.facts) ? ["facts"] : []), null, 2),
    isExisting: true, guardrailsOriginal: guardrails, interactionRulesOriginal: rules, channelBindingOriginal: channel, memoryOriginal: memory,
    costLimitTouched: false, rateLimitTouched: false, blockedActionsTouched: false, mayAnswerQuestionsTouched: false,
    autonomyTouched: false, channelProviderTouched: false, channelChatIdTouched: false, factsTouched: false,
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
  const guardrails = { ...form.guardrailsOriginal, ...parseObject(form.guardrailsAdvanced, "Guardrail details") };
  const interactionRules = { ...form.interactionRulesOriginal, ...parseObject(form.interactionRulesAdvanced, "Interaction-rule details") };
  const channelBinding = { ...form.channelBindingOriginal, ...parseObject(form.channelBindingAdvanced, "Channel details") };
  const memory = { ...form.memoryOriginal, ...parseObject(form.memoryAdvanced, "Memory details") };
  const costLimit = Number(form.costLimit);
  const rateLimit = Number(form.rateLimit);

  if (!form.isExisting || form.costLimitTouched) {
    if (form.costLimit.trim()) {
      if (!Number.isFinite(costLimit) || costLimit < 0) throw new Error("Cost ceiling must be a non-negative number.");
      guardrails.costLimit = costLimit;
    } else {
      delete guardrails.costLimit;
    }
  }
  if (!form.isExisting || form.rateLimitTouched) {
    if (form.rateLimit.trim()) {
      if (!Number.isFinite(rateLimit) || rateLimit < 0) throw new Error("Rate limit must be a non-negative number.");
      guardrails.rateLimit = { ...object(guardrails.rateLimit), perMinute: rateLimit };
    } else {
      delete guardrails.rateLimit;
    }
  }
  if (!form.isExisting || form.blockedActionsTouched) guardrails.blockedActions = form.blockedActions.split("\n").map((action) => action.trim()).filter(Boolean);
  if (!form.isExisting || form.mayAnswerQuestionsTouched) interactionRules.mayAnswerQuestions = form.mayAnswerQuestions;
  if (!form.isExisting || form.autonomyTouched) {
    if (form.autonomy.trim()) interactionRules.autonomy = form.autonomy.trim();
    else delete interactionRules.autonomy;
  }
  if (!form.isExisting || form.factsTouched) memory.facts = form.facts.map((fact) => fact.trim()).filter(Boolean);
  if (!form.isExisting || form.channelProviderTouched) {
    if (form.channelProvider.trim()) channelBinding.provider = form.channelProvider.trim();
    else delete channelBinding.provider;
  }
  if (!form.isExisting || form.channelChatIdTouched) {
    if (form.channelChatId.trim()) channelBinding.chatId = form.channelChatId.trim();
    else delete channelBinding.chatId;
  }
  return {
    name: form.name.trim(), role: form.role.trim(), systemPrompt: form.systemPrompt.trim(), model: form.model.trim(),
    codingToolEnabled: form.codingToolEnabled, guardrails, interactionRules, channelBinding: Object.keys(channelBinding).length ? channelBinding : null, memory,
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

export function AgentEditor({ availableModels, primaryModel }: { availableModels: readonly string[]; primaryModel: string }) {
  const agentTemplates = useMemo(() => templates(primaryModel), [primaryModel]);
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [skills, setSkills] = useState<SkillDTO[]>([]);
  const [schedules, setSchedules] = useState<ScheduleDTO[]>([]);
  const [selected, setSelected] = useState<AgentDTO | null>(null);
  const [form, setForm] = useState<EditorForm>(() => formFromAgent(primaryModel));
  const [scheduleForm, setScheduleForm] = useState<ScheduleForm>(blankSchedule);
  const [editingSchedule, setEditingSchedule] = useState<ScheduleDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [agentsLoadError, setAgentsLoadError] = useState("");
  const [schedulesLoading, setSchedulesLoading] = useState(false);
  const [schedulesLoadError, setSchedulesLoadError] = useState("");
  const [triggeringScheduleIds, setTriggeringScheduleIds] = useState<Set<string>>(() => new Set());
  const [scheduleTriggerStates, setScheduleTriggerStates] = useState<Record<string, ScheduleTriggerState>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const selectedAgentId = useRef<string | null>(null);
  const scheduleRequestGeneration = useRef(0);
  const triggeringScheduleIdsRef = useRef(new Set<string>());
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const deleteOpenerRef = useRef<HTMLElement | null>(null);
  const [modalRoot, setModalRoot] = useState<HTMLDivElement | null>(null);

  // The confirmation lives beside the application root so its modal boundary
  // covers both this editor and layout-owned controls such as SiteNav.
  useEffect(() => {
    return () => modalRoot?.remove();
  }, [modalRoot]);

  const loadSchedules = useCallback(async (agentId: string) => {
    const generation = ++scheduleRequestGeneration.current;
    setSchedules([]);
    setSchedulesLoading(true);
    setSchedulesLoadError("");
    try {
      const nextSchedules = await request<ScheduleDTO[]>(`/api/agents/${agentId}/schedules`);
      if (scheduleRequestGeneration.current === generation && selectedAgentId.current === agentId) setSchedules(nextSchedules);
    } catch (loadError) {
      if (scheduleRequestGeneration.current === generation && selectedAgentId.current === agentId) {
        setSchedulesLoadError(loadError instanceof Error ? loadError.message : "Unable to load schedules.");
      }
    } finally {
      if (scheduleRequestGeneration.current === generation && selectedAgentId.current === agentId) setSchedulesLoading(false);
    }
  }, []);

  const load = useCallback(async (agentId?: string) => {
    setLoading(true);
    setError("");
    setAgentsLoadError("");
    try {
      const [nextAgents, nextSkills] = await Promise.all([request<AgentDTO[]>("/api/agents"), request<SkillDTO[]>("/api/skills")]);
      setAgents(nextAgents);
      setSkills(nextSkills);
      const nextSelected = agentId ? nextAgents.find((agent) => agent.id === agentId) ?? null : null;
      selectedAgentId.current = nextSelected?.id ?? null;
      setSelected(nextSelected);
      setForm(formFromAgent(primaryModel, nextSelected ?? undefined));
      if (nextSelected) await loadSchedules(nextSelected.id);
      else {
        ++scheduleRequestGeneration.current;
        setSchedules([]);
        setSchedulesLoading(false);
        setSchedulesLoadError("");
      }
      setStale(false);
    } catch (loadError) {
      const detail = loadError instanceof Error ? loadError.message : "Unable to load agents from PostgreSQL.";
      setAgentsLoadError(detail);
      setError(detail);
    } finally {
      setLoading(false);
    }
  }, [loadSchedules, primaryModel]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selectAgent = async (agent: AgentDTO) => {
    selectedAgentId.current = agent.id;
    setSelected(agent);
    setForm(formFromAgent(primaryModel, agent));
    setEditingSchedule(null);
    setError("");
    setMessage("");
    setStale(false);
    void loadSchedules(agent.id);
  };

  const newAgent = () => {
    selectedAgentId.current = null;
    ++scheduleRequestGeneration.current;
    setSelected(null); setForm(formFromAgent(primaryModel)); setSchedules([]); setSchedulesLoading(false); setSchedulesLoadError(""); setEditingSchedule(null); setMessage(""); setError(""); setStale(false);
  };

  const beginDelete = (record: PendingDelete) => {
    deleteOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!modalRoot) {
      const root = document.createElement("div");
      root.dataset.agentEditorModalRoot = "";
      document.body.appendChild(root);
      setModalRoot(root);
    }
    setPendingDelete(record);
  };

  useEffect(() => {
    if (!pendingDelete) {
      deleteOpenerRef.current?.focus();
      return;
    }
    if (!modalRoot) return;

    // `inert` removes background controls from both the accessibility tree and
    // sequential focus order. Keeping this at the body-child boundary matters:
    // SiteNav is a layout sibling, not a child of AgentEditor.
    const background = Array.from(document.body.children).filter((child) => child !== modalRoot);
    const alreadyInert = new Set(background.filter((child) => child.hasAttribute("inert")));
    background.forEach((child) => child.setAttribute("inert", ""));
    const dialog = deleteDialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? []);
    window.setTimeout(() => focusable()[0]?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPendingDelete(null);
      }
      if (event.key === "Tab") {
        const controls = focusable();
        if (controls.length === 0) return;
        const first = controls[0]!;
        const last = controls.at(-1)!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }
    };
    // Modern browsers enforce inert themselves. These capture guards retain
    // the same modal boundary in partial implementations and in test DOMs.
    const keepFocusInDialog = (event: FocusEvent) => {
      if (event.target instanceof Node && !modalRoot.contains(event.target)) focusable()[0]?.focus();
    };
    const blockBackgroundInteraction = (event: Event) => {
      if (event.target instanceof Node && !modalRoot.contains(event.target)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", keepFocusInDialog, true);
    document.addEventListener("pointerdown", blockBackgroundInteraction, true);
    document.addEventListener("click", blockBackgroundInteraction, true);
    return () => {
      background.filter((child) => !alreadyInert.has(child)).forEach((child) => child.removeAttribute("inert"));
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", keepFocusInDialog, true);
      document.removeEventListener("pointerdown", blockBackgroundInteraction, true);
      document.removeEventListener("click", blockBackgroundInteraction, true);
    };
  }, [modalRoot, pendingDelete]);

  const applyTemplate = (templateId: string) => {
    const template = agentTemplates.find((item) => item.id === templateId);
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
      setScheduleForm(blankSchedule()); setEditingSchedule(null); setMessage(editingSchedule ? "Schedule updated." : "Schedule created.");
    } catch (scheduleError) {
      const requestError = scheduleError as Error & { code?: string | null };
      setStale(requestError.code === "stale_update");
      setError(requestError.code === "stale_update" ? "This schedule changed elsewhere. Refresh the agent before saving again." : requestError.message);
    } finally { setSaving(false); }
  };

  const triggerSchedule = async (schedule: ScheduleDTO) => {
    // This ref closes the small gap before React has rendered the disabled
    // state, so a double-click still sends exactly one deliberate request.
    if (triggeringScheduleIdsRef.current.has(schedule.id)) return;
    triggeringScheduleIdsRef.current.add(schedule.id);
    setTriggeringScheduleIds((current) => new Set(current).add(schedule.id));
    setScheduleTriggerStates((current) => {
      const next = { ...current };
      delete next[schedule.id];
      return next;
    });
    try {
      const idempotencyKey = `schedule-trigger:${crypto.randomUUID()}`;
      const result = await request<ScheduleTriggerResult>(`/api/schedules/${schedule.id}/trigger`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey }),
      });
      setScheduleTriggerStates((current) => ({
        ...current,
        [schedule.id]: result.kind === "disabled"
          ? { kind: "disabled" }
          : { kind: result.kind, runId: result.runId },
      }));
    } catch (triggerError) {
      setScheduleTriggerStates((current) => ({
        ...current,
        [schedule.id]: { kind: "error", message: triggerError instanceof Error ? triggerError.message : "Unable to trigger this schedule." },
      }));
    } finally {
      triggeringScheduleIdsRef.current.delete(schedule.id);
      setTriggeringScheduleIds((current) => {
        const next = new Set(current);
        next.delete(schedule.id);
        return next;
      });
    }
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
  const setFacts = (facts: string[]) => setForm((current) => ({ ...current, facts, factsTouched: true }));

  return (
    <>
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
        <aside className="glass min-w-0 rounded-2xl p-2 lg:self-start">
          <div className="flex items-center justify-between px-2 py-2"><span className="text-xs font-medium uppercase tracking-[0.16em] text-[--foreground-subtle]">Roster</span><Badge>{agents.length}</Badge></div>
          {loading ? <p className="px-3 py-8 text-sm text-[--foreground-muted]">Loading agents…</p> : agentsLoadError ? (
            <div className="px-3 py-8 text-center"><p className="text-sm text-[--danger]">Could not load agents.</p><Button className="mt-3" size="sm" onClick={() => void load(selectedAgentId.current ?? undefined)}>Retry</Button></div>
          ) : agents.length === 0 ? (
            <div className="px-3 py-8 text-center"><AlienIcon className="mx-auto h-8 w-8 text-[--foreground-subtle]" /><p className="mt-3 text-sm text-[--foreground-muted]">No agents yet.</p><p className="mt-1 text-xs text-[--foreground-subtle]">Start with an opinionated template, then make it yours.</p></div>
          ) : <div className="space-y-1">{agents.map((agent) => <button key={agent.id} type="button" onClick={() => void selectAgent(agent)} className={`w-full min-w-0 rounded-xl px-3 py-3 text-left transition-colors ${selected?.id === agent.id ? "bg-[--surface-hover] ring-1 ring-[--accent]/50" : "hover:bg-[--surface-hover]"}`}><span className="block truncate text-sm font-medium text-[--foreground]">{agent.name}</span><span className="mt-0.5 block truncate text-xs text-[--foreground-muted]">{agent.role} · {agent.model}</span></button>)}</div>}
        </aside>

        <div className="glass min-w-0 rounded-2xl p-4 sm:p-6">
          <form onSubmit={(event) => void submitAgent(event)}>
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold text-[--foreground]">{selected ? `Edit ${selected.name}` : "Create an agent"}</h2><p className="mt-1 text-xs text-[--foreground-muted]">{selected ? "Changes use the version you opened; stale updates never overwrite another editor." : "Templates are starting points. Their prompts remain editable."}</p></div>{selected && <Button variant="danger" size="sm" onClick={() => beginDelete({ kind: "agent", id: selected.id, name: selected.name })}>Delete agent</Button>}</div>

          {!selected && <div className="mb-5"><Label htmlFor="agent-template">Start from a template</Label><Select id="agent-template" defaultValue="" onChange={(event) => applyTemplate(event.target.value)}><option value="">Choose a starting point</option>{agentTemplates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.role}</option>)}</Select></div>}
          <section className="grid min-w-0 gap-4 sm:grid-cols-2"><Field label="Name" htmlFor="agent-name"><Input id="agent-name" value={form.name} onChange={(event) => setField("name", event.target.value)} required /></Field><Field label="Role" htmlFor="agent-role"><Input id="agent-role" value={form.role} onChange={(event) => setField("role", event.target.value)} required /></Field><Field label="Model" htmlFor="agent-model"><Select id="agent-model" value={form.model} onChange={(event) => setField("model", event.target.value)} required>{availableModels.map((model) => <option key={model} value={model}>{model}</option>)}</Select></Field><Field label="OpenClaw reference" htmlFor="agent-openclaw"><Input id="agent-openclaw" value={form.openclawRef} onChange={(event) => setField("openclawRef", event.target.value)} placeholder="Optional external runtime id" /></Field></section>
          <div className="mt-4"><Field label="System prompt" htmlFor="agent-prompt"><Textarea id="agent-prompt" value={form.systemPrompt} onChange={(event) => setField("systemPrompt", event.target.value)} required /></Field></div>
          <p className="mt-2 rounded-xl border border-[--border] bg-[--surface-2]/40 p-3 text-xs leading-relaxed text-[--foreground-muted]"><strong className="text-[--foreground]">Fixed runtime contract.</strong> Structured output, platform tool surface, and message types are applied by the runtime and are not editable here.</p>

          <Section title="Tools and channel" icon={<SignalIcon className="h-4 w-4" />}>
            <label className="flex items-center gap-3 rounded-xl border border-[--border] bg-[--surface-2]/35 p-3 text-sm text-[--foreground]"><input id="agent-coding-tool-enabled" name="codingToolEnabled" type="checkbox" checked={form.codingToolEnabled} onChange={(event) => setField("codingToolEnabled", event.target.checked)} className="h-4 w-4 accent-[--accent]" /> Enable coding-tool access</label>
            <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2"><Field label="Channel provider" htmlFor="channel-provider"><Input id="channel-provider" value={form.channelProvider} onChange={(event) => { setField("channelProvider", event.target.value); setField("channelProviderTouched", true); }} placeholder="telegram" /></Field><Field label="Channel chat / destination" htmlFor="channel-chat"><Input id="channel-chat" value={form.channelChatId} onChange={(event) => { setField("channelChatId", event.target.value); setField("channelChatIdTouched", true); }} placeholder="42" /></Field></div>
            <p className="mt-2 text-xs text-[--foreground-subtle]">Destination is the provider-specific recipient, such as a Telegram chat ID. It is not an agent name or a workflow ID.</p>
            <Advanced label="Additional channel fields" id="channel-advanced" value={form.channelBindingAdvanced} onChange={(value) => setField("channelBindingAdvanced", value)} description="JSON object only. Use it for provider-supported keys beyond provider and destination, such as a threadId string." />
          </Section>

          <Section title="Interaction rules" icon={<RadarIcon className="h-4 w-4" />}>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2"><label className="flex items-center gap-3 rounded-xl border border-[--border] bg-[--surface-2]/35 p-3 text-sm text-[--foreground]"><input id="agent-may-answer-questions" name="mayAnswerQuestions" type="checkbox" checked={form.mayAnswerQuestions} onChange={(event) => { setField("mayAnswerQuestions", event.target.checked); setField("mayAnswerQuestionsTouched", true); }} className="h-4 w-4 accent-[--accent]" /> May answer questions</label><Field label="Autonomy level" htmlFor="agent-autonomy"><Input id="agent-autonomy" value={form.autonomy} onChange={(event) => { setField("autonomy", event.target.value); setField("autonomyTouched", true); }} placeholder="ask-before-risk" /></Field></div>
            <p className="mt-2 text-xs text-[--foreground-subtle]">Autonomy describes when this agent should pause for human direction. Use a short policy such as “ask-before-risk”; runtime enforcement remains out of scope.</p>
            <Advanced label="Additional interaction rules" id="interaction-advanced" value={form.interactionRulesAdvanced} onChange={(value) => setField("interactionRulesAdvanced", value)} description="JSON object only. Use this for a schema-supported persisted rule that has no dedicated control." />
          </Section>

          <Section title="Guardrails" icon={<CheckIcon className="h-4 w-4" />}>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2"><Field label="Cost ceiling" htmlFor="cost-limit"><Input id="cost-limit" type="number" min="0" step="any" value={form.costLimit} onChange={(event) => { setField("costLimit", event.target.value); setField("costLimitTouched", true); }} placeholder="12.50" /></Field><Field label="Rate limit per minute" htmlFor="rate-limit"><Input id="rate-limit" type="number" min="0" step="1" value={form.rateLimit} onChange={(event) => { setField("rateLimit", event.target.value); setField("rateLimitTouched", true); }} placeholder="8" /></Field></div>
            <p className="mt-2 text-xs text-[--foreground-subtle]">Cost ceiling is the agent-level budget per run in the control plane’s configured currency unit; it is not a per-request price. The engine refuses a wake once spend reaches the ceiling and pauses the run with a visible system message.</p>
            <div className="mt-4"><Field label="Blocked actions" htmlFor="blocked-actions"><Textarea id="blocked-actions" className="min-h-24" value={form.blockedActions} onChange={(event) => { setField("blockedActions", event.target.value); setField("blockedActionsTouched", true); }} placeholder={"create_ticket\npost_message"} /></Field><p className="mt-1 text-xs text-[--foreground-subtle]">One action per line. Platform tool commands listed here are rejected at the dispatch point and named in the wake prompt.</p></div>
            <Advanced label="Additional guardrail fields" id="guardrails-advanced" value={form.guardrailsAdvanced} onChange={(value) => setField("guardrailsAdvanced", value)} description="JSON object only. Preserve valid nested values here when they do not have a clearer dedicated control." />
          </Section>

          <Section title="Memory facts" icon={<AlienIcon className="h-4 w-4" />}><p className="mb-3 text-xs text-[--foreground-muted]">Facts are stored canonically in this agent’s <code className="text-[--accent]">memory.facts</code> field.</p><div className="space-y-2">{form.facts.map((fact, index) => <div key={index} className="flex min-w-0 gap-2"><Input name={`memoryFact${index + 1}`} aria-label={`Memory fact ${index + 1}`} value={fact} onChange={(event) => setFacts(form.facts.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} /><Button variant="danger" size="sm" aria-label={`Delete memory fact ${index + 1}`} onClick={() => setFacts(form.facts.filter((_, itemIndex) => itemIndex !== index))}>Remove</Button></div>)}</div><Button className="mt-3" size="sm" onClick={() => setFacts([...form.facts, ""])}>Add fact</Button><Advanced label="Additional memory details" id="memory-advanced" value={form.memoryAdvanced} onChange={(value) => setField("memoryAdvanced", value)} description="JSON object only, for canonical memory details beyond individual facts." /></Section>

          <div className="mt-7 flex flex-wrap justify-end gap-3"><Button type="submit" variant="primary" disabled={saving}>{saving ? "Saving…" : selected ? "Save changes" : "Create agent"}</Button></div>
          </form>

          {selected && <section className="mt-8 border-t border-[--border] pt-6"><h3 className="flex items-center gap-2 text-base font-semibold text-[--foreground]"><UfoIcon className="h-4 w-4 text-[--accent]" /> Attached skills</h3><p className="mt-1 text-xs text-[--foreground-muted]">Attachments use the FACT-8 skill endpoints; skill definitions remain managed by the control plane.</p><div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">{skills.length === 0 ? <p className="text-sm text-[--foreground-muted]">No skills exist yet.</p> : skills.map((skill) => { const attached = attachedSkillIds.has(skill.id); return <button key={skill.id} type="button" aria-pressed={attached} onClick={() => void toggleSkill(skill, attached)} className={`min-w-0 rounded-xl border p-3 text-left text-sm transition-colors ${attached ? "border-[--accent]/50 bg-[--accent]/10" : "border-[--border] bg-[--surface-2]/35 hover:bg-[--surface-hover]"}`}><span className="block truncate font-medium text-[--foreground]">{skill.name}</span><span className="mt-1 block truncate text-xs text-[--foreground-muted]">{attached ? "Attached · click to detach" : "Click to attach"}</span></button>; })}</div></section>}

          {selected && <section className="mt-8 border-t border-[--border] pt-6"><h3 className="flex items-center gap-2 text-base font-semibold text-[--foreground]"><CometIcon className="h-4 w-4 text-[--accent]" /> Schedule associations</h3><p className="mt-1 text-xs text-[--foreground-muted]">Enabled schedules are picked up by the platform engine without a restart. Trigger now creates one immediate run only when you click it.</p><div className="mt-3 space-y-2">{schedulesLoading ? <p className="rounded-xl border border-[--border] p-3 text-sm text-[--foreground-muted]">Loading schedules…</p> : schedulesLoadError ? <div className="rounded-xl border border-[--danger]/45 p-3 text-sm text-[--danger]"><p>Could not load schedules.</p><Button className="mt-2" size="sm" onClick={() => void loadSchedules(selected.id)}>Retry schedules</Button></div> : schedules.length === 0 ? <p className="rounded-xl border border-dashed border-[--border] p-3 text-sm text-[--foreground-muted]">No schedules are associated with this agent.</p> : schedules.map((schedule) => <ScheduleRow key={schedule.id} schedule={schedule} triggering={triggeringScheduleIds.has(schedule.id)} triggerState={scheduleTriggerStates[schedule.id]} onTrigger={() => void triggerSchedule(schedule)} onEdit={() => { setEditingSchedule(schedule); setScheduleForm({ cronExpression: schedule.cronExpression, taskPrompt: schedule.taskPrompt ?? "", enabled: schedule.enabled }); }} onDelete={() => beginDelete({ kind: "schedule", id: schedule.id, name: schedule.taskPrompt ?? schedule.cronExpression })} />)}</div><form onSubmit={(event) => void submitSchedule(event)} className="mt-4 rounded-xl border border-[--border] bg-[--surface-2]/25 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium text-[--foreground]">{editingSchedule ? "Edit schedule" : "Add schedule"}</h4>{editingSchedule && <Button size="sm" onClick={() => { setEditingSchedule(null); setScheduleForm(blankSchedule()); }}>Cancel edit</Button>}</div><div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2"><Field label="Cron expression" htmlFor="schedule-cron"><Input id="schedule-cron" value={scheduleForm.cronExpression} onChange={(event) => setScheduleForm((current) => ({ ...current, cronExpression: event.target.value }))} required /></Field><label className="flex items-end gap-2 pb-2 text-sm text-[--foreground]"><input id="schedule-enabled" name="scheduleEnabled" type="checkbox" checked={scheduleForm.enabled} onChange={(event) => setScheduleForm((current) => ({ ...current, enabled: event.target.checked }))} className="h-4 w-4 accent-[--accent]" /> Enabled</label></div><p className="mt-2 text-xs text-[--foreground-subtle]">Use five numeric fields: minute hour day-of-month month day-of-week. Example: 0 9 * * 1-5.</p><div className="mt-3"><Field label="Standing task" htmlFor="schedule-task"><Textarea id="schedule-task" className="min-h-24" value={scheduleForm.taskPrompt} onChange={(event) => setScheduleForm((current) => ({ ...current, taskPrompt: event.target.value }))} required /></Field></div><Button className="mt-3" type="submit" size="sm" disabled={saving}>{editingSchedule ? "Save schedule" : "Add schedule"}</Button></form></section>}
        </div>
      </div>

    </div>
      {pendingDelete && modalRoot && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
          <div ref={deleteDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-description" className="glass w-full max-w-md rounded-2xl p-5 shadow-2xl">
            <h2 id="delete-title" className="text-lg font-semibold text-[--foreground]">Delete {pendingDelete.kind === "agent" ? "agent" : "schedule"}?</h2>
            <p id="delete-description" className="mt-2 text-sm text-[--foreground-muted]">{pendingDelete.kind === "agent" ? `Delete ${pendingDelete.name}? Existing schedule associations must be removed first.` : `Delete the schedule for “${pendingDelete.name}”? This cannot be undone.`}</p>
            <div className="mt-5 flex justify-end gap-3"><Button onClick={() => setPendingDelete(null)}>Cancel</Button><Button variant="danger" onClick={() => void confirmDelete()} disabled={saving}>Delete</Button></div>
          </div>
        </div>,
        modalRoot,
      )}
    </>
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

function ScheduleRow({ schedule, triggering, triggerState, onTrigger, onEdit, onDelete }: {
  schedule: ScheduleDTO;
  triggering: boolean;
  triggerState: ScheduleTriggerState | undefined;
  onTrigger: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-[--border] bg-[--surface-2]/35 p-3">
    <div className="min-w-0"><p className="truncate font-mono text-xs text-[--accent]">{schedule.cronExpression}</p><p className="mt-1 truncate text-sm text-[--foreground]">{schedule.taskPrompt}</p><p className="mt-1 text-xs text-[--foreground-muted]">{schedule.enabled ? "Enabled" : "Disabled"}</p>
      {triggerState?.kind === "created" && <p role="status" className="mt-2 text-xs text-[--success]">Run #{triggerState.runId} created. <Button asChild size="sm" className="ml-2 align-middle"><Link href={`/monitoring?tab=board&runId=${encodeURIComponent(triggerState.runId)}`}>View in Monitoring</Link></Button></p>}
      {triggerState?.kind === "duplicate" && <p role="status" className="mt-2 text-xs text-amber-200">Existing run #{triggerState.runId} returned for this request. <Button asChild size="sm" className="ml-2 align-middle"><Link href={`/monitoring?tab=board&runId=${encodeURIComponent(triggerState.runId)}`}>View in Monitoring</Link></Button></p>}
      {triggerState?.kind === "disabled" && <p role="status" className="mt-2 text-xs text-amber-200">This schedule is disabled. No run was created.</p>}
      {triggerState?.kind === "error" && <p role="alert" className="mt-2 text-xs text-[--danger]">Trigger failed: {triggerState.message}</p>}
    </div>
    <div className="flex flex-wrap gap-2"><Button variant="primary" size="sm" onClick={onTrigger} disabled={triggering}>{triggering ? "Triggering…" : "Trigger now"}</Button><Button size="sm" onClick={onEdit}>Edit</Button><Button variant="danger" size="sm" onClick={onDelete}>Delete</Button></div>
  </div>;
}
