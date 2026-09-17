import { createHash, randomBytes } from "node:crypto";
import type { Agent, Run, RunDetail, Workflow } from "../shared/types.js";
import type { IntegrationDependencies } from "./integrations.js";
import {
  HELP,
  telegramStatusText,
  type TelegramCommand,
  type TelegramMarkup,
} from "./telegram-ui.js";

type Button = TelegramMarkup["inline_keyboard"][number][number];
type Action =
  | { kind: "home" | "cancel" }
  | { kind: "workflows"; page: number; improve?: boolean }
  | { kind: "agents" | "runs"; page: number }
  | { kind: "workflow"; id: string }
  | { kind: "agent"; id: string }
  | {
      kind: "start" | "sources";
      id: string;
      fingerprint: string;
      page?: number;
    }
  | {
      kind: "source";
      id: string;
      fingerprint: string;
      runId: string;
      revisionId: string;
    }
  | { kind: "run" | "confirmStop" | "stop"; id: string }
  | { kind: "approve" | "feedback"; id: string; approvalToken: string };
type SavedAction = {
  chatId: string;
  expiresAt: string;
  action: Action;
  used?: boolean;
};
type Pending = {
  id: string;
  label: string;
  expiresAt: string;
  submittedBy?: number;
  submittedRunId?: string;
} & (
  | {
      kind: "workflow";
      workflowId: string;
      fingerprint: string;
      parentRunId?: string;
      revisionId?: string;
    }
  | { kind: "feedback"; runId: string; approvalToken: string }
);

type MenuDependencies = IntegrationDependencies & {
  getState: <T>(key: string) => Promise<T | null>;
  setState: (key: string, value: unknown) => Promise<void>;
  deleteState: (key: string) => Promise<void>;
  queueOutbound: (
    key: string,
    chatId: string,
    text: string,
    markup?: TelegramMarkup,
  ) => Promise<void>;
  rememberRun: (
    chatId: string,
    run: Run,
    updateId: number,
    prompt: string,
    agentId?: string,
  ) => Promise<void>;
  publicOrigin?: string;
};
const pageSize = 6;
const key = (prefix: string, id: string) =>
  `${prefix}:${encodeURIComponent(id)}`;
const clip = (text: string, length = 80) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;
const expiry = () => new Date(Date.now() + 24 * 60 * 60_000).toISOString();
const expired = (at: string) => new Date(at).getTime() <= Date.now();
const pendingKey = (chatId: string) => key("telegram.pending", chatId);
const mutates = (action: Action) =>
  ["start", "source", "approve", "feedback", "stop", "cancel"].includes(
    action.kind,
  );

// Navigation is read-only. Only explicit start/approval actions can reach the engine.
export function createTelegramMenu(deps: MenuDependencies) {
  async function button(
    chatId: string,
    text: string,
    action: Action,
  ): Promise<Button> {
    const id = randomBytes(12).toString("hex");
    await deps.setState(key("telegram.button", id), {
      chatId,
      expiresAt: expiry(),
      action,
    } satisfies SavedAction);
    return { text: clip(text, 60), callback_data: `of:${id}` };
  }
  async function navigation(chatId: string): Promise<Button[][]> {
    return [
      [
        await button(chatId, "Workflows", { kind: "workflows", page: 0 }),
        await button(chatId, "Agents", { kind: "agents", page: 0 }),
        await button(chatId, "Runs", { kind: "runs", page: 0 }),
      ],
    ];
  }
  async function send(
    replyKey: string,
    chatId: string,
    text: string,
    rows: Button[][] = [],
  ) {
    const pending = await deps.getState<Pending>(pendingKey(chatId));
    if (
      pending &&
      pending.submittedBy === undefined &&
      !expired(pending.expiresAt)
    ) {
      text += `\n\nWaiting for: ${pending.label}. Your next message supplies this request.`;
      rows.push([await button(chatId, "Cancel request", { kind: "cancel" })]);
    } else if (await deps.getState(key("telegram.pending-improve", chatId))) {
      text +=
        "\n\nAn improvement request is pending. Your next message will describe the change. /cancel discards it.";
    }
    rows.push(...(await navigation(chatId)));
    await deps.queueOutbound(replyKey, chatId, text, { inline_keyboard: rows });
  }
  async function workflow(id: string) {
    const rows = await deps.query<{ data: Workflow }>(
      "SELECT data FROM workflows WHERE id=$1 AND template=false",
      [id],
    );
    const value = rows[0]?.data;
    if (!value) return null;
    const agents = (await deps.listAgents())
      .filter((a) => value.nodes.some((n) => n.agentId === a.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ workflow: value, agents }))
      .digest("hex");
    return { value, agents, fingerprint };
  }
  async function owns(chatId: string, id: string) {
    return (
      (await deps.getState<{ chatId: string }>(key("telegram.run", id)))
        ?.chatId === chatId
    );
  }
  async function clearPending(chatId: string) {
    await deps.deleteState(pendingKey(chatId));
    await deps.deleteState(key("telegram.pending-improve", chatId));
  }
  async function setPending(chatId: string, pending: Pending) {
    await deps.deleteState(key("telegram.pending-improve", chatId));
    await deps.setState(pendingKey(chatId), pending);
  }
  async function sourceValid(runId: string, revisionId?: string) {
    const detail = await deps.getRun(runId);
    return (
      !!detail &&
      detail.run.status === "completed" &&
      (!revisionId || detail.run.revisionId === revisionId) &&
      detail.revisions.some(
        (r) =>
          r.id === detail.run.revisionId &&
          r.approved &&
          r.files.includes("index.html"),
      )
    );
  }
  async function pages(
    chatId: string,
    action: Extract<Action, { page: number }>,
    more: boolean,
  ) {
    const row: Button[] = [];
    if (action.page > 0)
      row.push(
        await button(chatId, "Previous", { ...action, page: action.page - 1 }),
      );
    if (more)
      row.push(
        await button(chatId, "Next", { ...action, page: action.page + 1 }),
      );
    return row.length ? [row] : [];
  }
  async function runCard(
    replyKey: string,
    chatId: string,
    detail: RunDetail,
    prefix = "",
  ) {
    const { run, executionSnapshot } = detail;
    const current = executionSnapshot.workflow?.nodes.find(
      (n) => n.id === run.currentNode,
    );
    const agent = executionSnapshot.agents.find(
      (a) => a.id === (current?.agentId ?? run.agentId),
    );
    const title =
      executionSnapshot.workflow?.name ?? agent?.name ?? "Agent request";
    const context = `${title}\n${clip(run.prompt, 300)}${agent ? `\n${current?.label ?? agent.name}: ${agent.name} · ${agent.model}` : ""}`;
    const rows: Button[][] = [];
    if (deps.publicOrigin)
      rows.push([
        {
          text: "Open in OrbitFlow",
          url: `${deps.publicOrigin}/?run=${encodeURIComponent(run.id)}`,
        },
      ]);
    if (run.status === "awaiting_approval" && detail.approvalToken) {
      rows.push([
        await button(
          chatId,
          detail.approvalKind === "turn"
            ? "Allow next turn"
            : "Approve revision",
          { kind: "approve", id: run.id, approvalToken: detail.approvalToken },
        ),
        await button(chatId, "Request changes", {
          kind: "feedback",
          id: run.id,
          approvalToken: detail.approvalToken,
        }),
      ]);
    }
    const controls = [
      await button(chatId, "Refresh status", { kind: "run", id: run.id }),
    ];
    if (["queued", "running", "awaiting_approval"].includes(run.status))
      controls.push(
        await button(chatId, "Stop run", { kind: "confirmStop", id: run.id }),
      );
    rows.push(controls);
    await send(
      replyKey,
      chatId,
      `${prefix ? `${prefix}\n\n` : ""}${context}\n\n${clip(telegramStatusText(detail), 2300)}`,
      rows,
    );
  }
  async function dispatch(chatId: string, replyKey: string, action: Action) {
    if (action.kind === "cancel") {
      await clearPending(chatId);
      return send(
        replyKey,
        chatId,
        "Pending request cleared. Existing runs keep running. New messages go to your default Telegram agent.",
      );
    }
    if (action.kind === "home") {
      const connected = (await deps.listAgents()).find((a) => a.telegram);
      return send(
        replyKey,
        chatId,
        `OrbitFlow\nBrowse a workflow to start work, inspect your agents, or check recent runs.\n\n${connected ? `Default chat: ${connected.name}\nModel: ${connected.model}` : "No default chat agent is connected. Configure one in OrbitFlow."}`,
      );
    }
    if (action.kind === "workflows") {
      const all = (
        await deps.query<{ data: Workflow }>(
          "SELECT data FROM workflows WHERE template=false ORDER BY data->>'name',id",
        )
      )
        .map((r) => r.data)
        .filter((w) => !action.improve || w.requiresSource);
      const items = all.slice(
        action.page * pageSize,
        (action.page + 1) * pageSize,
      );
      const rows: Button[][] = [];
      for (const w of items)
        rows.push([
          await button(
            chatId,
            `${w.name}${w.requiresSource ? " · Improve" : ""}`,
            { kind: "workflow", id: w.id },
          ),
        ]);
      rows.push(
        ...(await pages(
          chatId,
          action,
          all.length > (action.page + 1) * pageSize,
        )),
      );
      return send(
        replyKey,
        chatId,
        items.length
          ? `${action.improve ? "Improvement workflows" : "Saved workflows"} · page ${action.page + 1}\nChoose one to see its agents, models, and start options.`
          : "No matching saved workflows. Load a template or create a workflow in OrbitFlow.",
        rows,
      );
    }
    if (action.kind === "agents") {
      const all = (await deps.listAgents()).sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      );
      const items = all.slice(
        action.page * pageSize,
        (action.page + 1) * pageSize,
      );
      const rows: Button[][] = [];
      for (const a of items)
        rows.push([
          await button(
            chatId,
            `${a.name}${a.telegram ? " · Default chat" : ""}`,
            { kind: "agent", id: a.id },
          ),
        ]);
      rows.push(
        ...(await pages(
          chatId,
          action,
          all.length > (action.page + 1) * pageSize,
        )),
      );
      return send(
        replyKey,
        chatId,
        items.length
          ? `Agents · page ${action.page + 1}\nInspect an agent's role and model. Browsing does not change who receives your messages.`
          : "No agents yet. Create an agent in OrbitFlow.",
        rows,
      );
    }
    if (action.kind === "agent") {
      const agent = (await deps.listAgents()).find((a) => a.id === action.id);
      if (!agent)
        return send(
          replyKey,
          chatId,
          "This agent no longer exists. Open Agents for the current list.",
        );
      const flows = (
        await deps.query<{ data: Workflow }>(
          "SELECT data FROM workflows WHERE template=false ORDER BY data->>'name',id",
        )
      )
        .map((r) => r.data)
        .filter((w) => w.nodes.some((n) => n.agentId === agent.id));
      return send(
        replyKey,
        chatId,
        `${agent.name}\n${clip(agent.role, 300)}\nModel: ${agent.model}\nTools: ${agent.tools.filter((t) => !agent.guardrails.blockedActions.includes(t)).join(", ") || "none"}\nApproval: ${approvalLabel(agent)}\nLimits: ${agent.guardrails.maxTurns} workflow turns; $${agent.guardrails.maxCostUsd} per run\n\n${agent.telegram ? "Default Telegram agent. Plain messages reach this agent when no request is pending." : "Workflow / web agent. Direct Telegram chat is not enabled."}\nWorkflows: ${clip(flows.map((w) => w.name).join(", ") || "none", 800)}`,
      );
    }
    if (action.kind === "workflow") {
      const found = await workflow(action.id);
      if (!found)
        return send(
          replyKey,
          chatId,
          "This workflow no longer exists. Open Workflows for the current list.",
        );
      const { value: w, agents, fingerprint } = found;
      const assignments = w.nodes.map((n) => {
        const a = agents.find((a) => a.id === n.agentId);
        return `${n.id === w.entryNode ? "Start → " : ""}${clip(n.label, 50)}: ${a ? `${clip(a.name, 50)} · ${clip(a.model, 100)}` : "Missing agent"}`;
      });
      const rows = w.nodes.every((n) => agents.some((a) => a.id === n.agentId))
        ? [
            [
              await button(
                chatId,
                w.requiresSource
                  ? "Choose approved application"
                  : "Start workflow",
                {
                  kind: w.requiresSource ? "sources" : "start",
                  id: w.id,
                  fingerprint,
                  page: 0,
                },
              ),
            ],
          ]
        : [];
      return send(
        replyKey,
        chatId,
        `${w.name}\n${clip(w.description, 600)}\n\n${clip(assignments.join("\n"), 1400)}\n\n${agents.some((a) => a.approval === "always") ? "Some steps require approval before execution." : agents.some((a) => a.approval === "publish") ? "The resulting application requires your approval." : "No human approval is configured."}\n${clip(agents.map((a) => `${a.name}: up to ${a.guardrails.maxTurns} turns / $${a.guardrails.maxCostUsd}`).join("\n"), 500)}\nStarts with the current saved configuration.`,
        rows,
      );
    }
    if (
      action.kind === "start" ||
      action.kind === "sources" ||
      action.kind === "source"
    ) {
      const found = await workflow(action.id);
      if (!found || found.fingerprint !== action.fingerprint) {
        await send(
          replyKey,
          chatId,
          "This workflow or one of its agents changed. Review the current configuration before starting.",
        );
        if (found)
          await dispatch(chatId, `${replyKey}:current`, {
            kind: "workflow",
            id: action.id,
          });
        return;
      }
      if (action.kind === "sources") {
        const page = action.page ?? 0;
        const rows = await deps.query<{ data: Run }>(
          "SELECT r.data FROM runs r JOIN revisions v ON v.id=r.data->>'revisionId' WHERE r.data->>'status'='completed' AND v.approved=true AND v.files ? 'index.html' ORDER BY r.created_at DESC,r.id LIMIT $1 OFFSET $2",
          [pageSize + 1, page * pageSize],
        );
        const buttons: Button[][] = [];
        for (const { data: run } of rows.slice(0, pageSize))
          buttons.push([
            await button(
              chatId,
              `${run.createdAt.slice(0, 10)} · ${clip(run.prompt, 40)}`,
              {
                kind: "source",
                id: action.id,
                fingerprint: action.fingerprint,
                runId: run.id,
                revisionId: run.revisionId!,
              },
            ),
          ]);
        const pagination: Button[] = [];
        if (page > 0)
          pagination.push(
            await button(chatId, "Previous", { ...action, page: page - 1 }),
          );
        if (rows.length > pageSize)
          pagination.push(
            await button(chatId, "Next", { ...action, page: page + 1 }),
          );
        if (pagination.length) buttons.push(pagination);
        return send(
          replyKey,
          chatId,
          rows.length
            ? `${found.value.name}\nChoose an approved application from your workspace · page ${page + 1}.`
            : "No approved applications on this page. Build and approve an application in OrbitFlow first.",
          buttons,
        );
      }
      if (found.value.requiresSource && action.kind !== "source")
        return send(
          replyKey,
          chatId,
          "This workflow needs an approved source application. Open Workflows to choose one.",
        );
      if (
        action.kind === "source" &&
        !(await sourceValid(action.runId, action.revisionId))
      )
        return send(
          replyKey,
          chatId,
          "That application revision is no longer an approved source. Choose it again from Workflows.",
        );
      const source =
        action.kind === "source" ? await deps.getRun(action.runId) : null;
      await setPending(chatId, {
        id: randomBytes(12).toString("hex"),
        kind: "workflow",
        workflowId: action.id,
        fingerprint: action.fingerprint,
        ...(action.kind === "source"
          ? { parentRunId: action.runId, revisionId: action.revisionId }
          : {}),
        label: `${found.value.name}${source ? ` — ${clip(source.run.prompt, 100)}` : ""}`,
        expiresAt: expiry(),
      });
      return send(
        replyKey,
        chatId,
        source
          ? `Selected application: ${clip(source.run.prompt, 200)}\nSend the change you want to make.`
          : "Send what you want this workflow to do. Sending your request starts the run.",
      );
    }
    if (action.kind === "runs") {
      const rows = await deps.query<{ data: Run }>(
        "SELECT r.data FROM runs r JOIN integration_state s ON s.key='telegram.run:'||r.id WHERE s.value->>'chatId'=$1 ORDER BY (r.data->>'status' IN ('queued','running','awaiting_approval')) DESC,r.created_at DESC,r.id LIMIT $2 OFFSET $3",
        [chatId, pageSize + 1, action.page * pageSize],
      );
      const buttons: Button[][] = [];
      for (const { data: run } of rows.slice(0, pageSize))
        buttons.push([
          await button(
            chatId,
            `${run.status.replaceAll("_", " ")} · ${clip(run.prompt, 35)}`,
            { kind: "run", id: run.id },
          ),
        ]);
      buttons.push(...(await pages(chatId, action, rows.length > pageSize)));
      return send(
        replyKey,
        chatId,
        rows.length
          ? `Runs from this Telegram chat · page ${action.page + 1}\nActive runs appear first. Choose a run for status and actions.`
          : "No runs on this page. Start one from Workflows. Runs started on the website remain available in OrbitFlow.",
        buttons,
      );
    }
    if (!("id" in action)) return;
    if (!(await owns(chatId, action.id)))
      return send(
        replyKey,
        chatId,
        "That run does not belong to this Telegram conversation.",
      );
    const detail = await deps.getRun(action.id);
    if (!detail) return send(replyKey, chatId, "This run no longer exists.");
    if (action.kind === "run") return runCard(replyKey, chatId, detail);
    if (action.kind === "confirmStop") {
      if (
        !["queued", "running", "awaiting_approval"].includes(detail.run.status)
      )
        return runCard(
          replyKey,
          chatId,
          detail,
          "This run has already stopped.",
        );
      return send(
        replyKey,
        chatId,
        `Stop this run?\n${clip(detail.run.prompt, 300)}\nCompleted revisions and recorded usage will remain available.`,
        [
          [
            await button(chatId, "Yes, stop run", {
              kind: "stop",
              id: action.id,
            }),
            await button(chatId, "Keep running", {
              kind: "run",
              id: action.id,
            }),
          ],
        ],
      );
    }
    if (action.kind === "stop") {
      if (
        ["queued", "running", "awaiting_approval"].includes(detail.run.status)
      )
        await deps.cancel(action.id);
      const pending = await deps.getState<Pending>(pendingKey(chatId));
      if (pending?.kind === "feedback" && pending.runId === action.id)
        await clearPending(chatId);
      return runCard(
        replyKey,
        chatId,
        (await deps.getRun(action.id))!,
        "Run stopped.",
      );
    }
    if (action.kind !== "approve" && action.kind !== "feedback") return;
    if (
      detail.run.status !== "awaiting_approval" ||
      detail.approvalToken !== action.approvalToken
    )
      return runCard(
        replyKey,
        chatId,
        detail,
        "That approval button is outdated. Use the current run actions below.",
      );
    if (action.kind === "feedback") {
      await setPending(chatId, {
        id: randomBytes(12).toString("hex"),
        kind: "feedback",
        runId: action.id,
        approvalToken: action.approvalToken,
        label: `changes to ${clip(detail.run.prompt, 120)}`,
        expiresAt: expiry(),
      });
      return send(
        replyKey,
        chatId,
        "Describe what needs to change. Sending your feedback restarts the revision workflow.",
      );
    }
    await deps.approve(action.id, true, "", action.approvalToken);
    const pending = await deps.getState<Pending>(pendingKey(chatId));
    if (pending?.kind === "feedback" && pending.runId === action.id)
      await clearPending(chatId);
    return runCard(
      replyKey,
      chatId,
      (await deps.getRun(action.id))!,
      "Approved.",
    );
  }
  async function submit(
    chatId: string,
    updateId: number,
    replyKey: string,
    prompt: string,
    pending: Pending,
  ) {
    if (pending.submittedBy !== undefined) {
      if (pending.submittedBy !== updateId) return false;
      if (pending.submittedRunId) {
        const detail = await deps.getRun(pending.submittedRunId);
        if (detail)
          await deps.rememberRun(chatId, detail.run, updateId, prompt);
      }
      return true;
    }
    if (expired(pending.expiresAt)) {
      await clearPending(chatId);
      await send(
        replyKey,
        chatId,
        "The pending request expired. Your message was not sent to an agent. Choose the workflow or run again.",
      );
      return true;
    }
    if (pending.kind === "feedback") {
      const detail = await deps.getRun(pending.runId);
      if (
        !(await owns(chatId, pending.runId)) ||
        detail?.approvalToken !== pending.approvalToken ||
        detail.run.status !== "awaiting_approval"
      ) {
        await clearPending(chatId);
        await send(
          replyKey,
          chatId,
          "The pending approval changed. Your feedback was not submitted. Open Runs for the current actions.",
        );
        return true;
      }
      await deps.approve(pending.runId, false, prompt, pending.approvalToken);
      await deps.setState(pendingKey(chatId), {
        ...pending,
        submittedBy: updateId,
      });
      await runCard(
        replyKey,
        chatId,
        (await deps.getRun(pending.runId))!,
        "Feedback sent. The workflow will revise the application.",
      );
      return true;
    }
    const found = await workflow(pending.workflowId);
    if (
      !found ||
      found.fingerprint !== pending.fingerprint ||
      (pending.parentRunId &&
        !(await sourceValid(pending.parentRunId, pending.revisionId)))
    ) {
      await clearPending(chatId);
      await send(
        replyKey,
        chatId,
        "The selected workflow, agents, or source revision changed. Your request was not started. Select it again from Workflows.",
      );
      return true;
    }
    const run = await deps.enqueue({
      workflowId: pending.workflowId,
      parentRunId: pending.parentRunId,
      prompt,
      channel: { chatId, updateId },
      idempotencyKey: `telegram:request:${pending.id}`,
    });
    // Keep the receipt until another selection replaces it: redelivered text must not become a chat run.
    await deps.setState(pendingKey(chatId), {
      ...pending,
      submittedBy: updateId,
      submittedRunId: run.id,
    });
    await deps.rememberRun(chatId, run, updateId, prompt);
    return true;
  }
  return {
    runCard,
    clearPending,
    async callback(chatId: string, updateId: number, data?: string) {
      const replyKey = key("telegram.outbound", `${chatId}:${updateId}:menu`);
      const id = /^of:([a-f0-9]{24})$/.exec(data ?? "")?.[1];
      const saved = id
        ? await deps.getState<SavedAction>(key("telegram.button", id))
        : null;
      if (!saved || saved.chatId !== chatId || expired(saved.expiresAt))
        return send(
          replyKey,
          chatId,
          "This menu button expired or is unavailable. Open a fresh menu below.",
        );
      if (saved.used)
        return send(
          replyKey,
          chatId,
          "This action was already handled. Use the current menu or run status.",
        );
      await dispatch(chatId, replyKey, saved.action);
      if (mutates(saved.action))
        await deps.setState(key("telegram.button", id!), {
          ...saved,
          used: true,
        });
    },
    async command(chatId: string, updateId: number, command: TelegramCommand) {
      const replyKey = key("telegram.outbound", `${chatId}:${updateId}:menu`);
      if (command.kind === "chat") {
        const pending = await deps.getState<Pending>(pendingKey(chatId));
        return pending
          ? submit(chatId, updateId, replyKey, command.prompt, pending)
          : false;
      }
      if (command.kind === "help" || command.kind === "invalid") {
        await send(
          replyKey,
          chatId,
          command.kind === "help" ? HELP : command.message,
        );
        return true;
      }
      if (command.kind === "home" || command.kind === "cancel") {
        await dispatch(chatId, replyKey, { kind: command.kind });
        return true;
      }
      if (
        command.kind === "workflows" ||
        command.kind === "agents" ||
        command.kind === "runs"
      ) {
        await dispatch(chatId, replyKey, { kind: command.kind, page: 0 });
        return true;
      }
      if (command.kind === "improve" && command.arguments.length === 0) {
        await dispatch(chatId, replyKey, {
          kind: "workflows",
          page: 0,
          improve: true,
        });
        return true;
      }
      if (command.kind === "status") {
        await dispatch(chatId, replyKey, { kind: "run", id: command.runId });
        return true;
      }
      return false;
    },
    async pruneButtons() {
      await deps.query(
        "DELETE FROM integration_state WHERE key LIKE 'telegram.button:%' AND value->>'expiresAt'<$1",
        [new Date().toISOString()],
      );
    },
  };
}

function approvalLabel(agent: Agent) {
  return agent.approval === "always"
    ? "before each turn"
    : agent.approval === "publish"
      ? "before application release"
      : "none";
}
