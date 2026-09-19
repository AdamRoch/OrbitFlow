import { createTelegramMenu } from "./telegram-menu.js";
import {
  HELP,
  REPORTABLE_STATUSES,
  MAX_TELEGRAM_MESSAGE,
  advanceTelegramOffset,
  isAuthorizedChat,
  parseTelegramCommand,
  telegramStatusText,
  telegramCommands,
  type TelegramUpdate,
  type TelegramMarkup,
} from "./telegram-ui.js";
export {
  advanceTelegramOffset,
  isAuthorizedChat,
  parseTelegramCommand,
  telegramStatusText,
} from "./telegram-ui.js";
import { CronExpressionParser } from "cron-parser";
import type { Agent, Run, RunDetail, ScheduleStatus } from "../shared/types.js";

type Query = <T>(sql: string, params?: unknown[]) => Promise<T[]>;
type EnqueueInput = {
  workflowId?: string;
  agentId?: string;
  prompt: string;
  parentRunId?: string;
  channel?: { chatId: string; updateId: number };
  idempotencyKey?: string;
  requestSender?: string;
};
export type IntegrationDependencies = {
  query: Query;
  listAgents: () => Promise<Agent[]>;
  enqueue: (input: EnqueueInput) => Promise<Run>;
  approve: (
    runId: string,
    approved: boolean,
    feedback: string,
    approvalToken: string,
  ) => Promise<Run>;
  cancel: (id: string) => Promise<Run>;
  getRun: (id: string) => Promise<RunDetail | null>;
  log: (runId: string | null, kind: string, content: string) => Promise<void>;
};

type Conversation = {
  agentId: string;
  runIds: string[];
  turns: {
    role: "user" | "assistant";
    text: string;
    at: string;
    runId?: string;
  }[];
};
type RunWatch = { chatId: string; lastNotice: string | null };
type Outbound = {
  chatId: string;
  text: string;
  sent: boolean;
  createdAt: string;
  markup?: TelegramMarkup;
};
type ScheduleState = {
  expression: string;
  nextAt: string | null;
  pendingAt?: string;
  error?: string;
};
type PendingImprove = { workflowId: string; parentRunId: string };

export function everyIntervalMs(expression: string): number | null {
  const match = /^@every\s+(\d+)\s*(s|m|h|d)$/i.exec(expression.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const factor: { [key: string]: number } = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const result = value * factor[match[2].toLowerCase()];
  return value > 0 && Number.isSafeInteger(result) ? result : null;
}

export function nextScheduleWake(expression: string, after: Date): Date {
  const interval = everyIntervalMs(expression);
  if (interval !== null) return new Date(after.getTime() + interval);
  return CronExpressionParser.parse(expression, { currentDate: after })
    .next()
    .toDate();
}

export async function listScheduleStatuses(
  query: Query,
  listAgents: () => Promise<Agent[]>,
): Promise<ScheduleStatus[]> {
  const [agents, rows] = await Promise.all([
    listAgents(),
    query<{ key: string; value: ScheduleState }>(
      "SELECT key,value FROM integration_state WHERE key LIKE $1 ORDER BY key",
      ["schedule:%"],
    ),
  ]);
  const states = new Map(rows.map((row) => [row.key, row.value]));
  return agents.map((agent) => {
    const state = states.get(stateKey("schedule", agent.id));
    const current = state?.expression === agent.schedule.expression;
    return {
      agentId: agent.id,
      enabled: agent.schedule.enabled,
      expression: agent.schedule.expression,
      nextAt: agent.schedule.enabled && current ? state.nextAt : null,
      error: agent.schedule.enabled && current ? (state.error ?? null) : null,
    };
  });
}

export async function selectGuidedImprove(
  query: Query,
): Promise<{ workflowId: string; parentRunId: string } | { error: string }> {
  const workflows = await query<{ data: { id: string } }>(
    "SELECT data FROM workflows WHERE template=false AND COALESCE(data->>'requiresSource','false')='true' ORDER BY id",
  );
  if (workflows.length === 0)
    return {
      error: "Load one Improve application template in OrbitFlow first.",
    };
  if (workflows.length > 1)
    return {
      error:
        "More than one improve workflow is loaded. Use /improve <workflow ID> <run ID> <change>.",
    };
  const sources = await query<{ data: Run }>(
    `SELECT r.data FROM runs r JOIN revisions v ON v.id=r.data->>'revisionId' WHERE r.data->>'status'='completed' AND v.approved=true AND v.files ? 'index.html' ORDER BY r.created_at DESC LIMIT 1`,
  );
  if (!sources[0])
    return {
      error: "Approve a generated browser application before improving it.",
    };
  return {
    workflowId: workflows[0].data.id,
    parentRunId: sources[0].data.id,
  };
}

function truncate(text: string): string {
  return text.length <= MAX_TELEGRAM_MESSAGE
    ? text
    : `${text.slice(0, MAX_TELEGRAM_MESSAGE - 16)}\n[truncated]`;
}

function stateKey(prefix: string, id: string): string {
  return `${prefix}:${encodeURIComponent(id)}`;
}

export function createOutboxDrain(
  drain: () => Promise<void>,
): () => Promise<void> {
  let active: Promise<void> | null = null;
  return () => {
    if (!active)
      active = drain().finally(() => {
        active = null;
      });
    return active;
  };
}

export function startIntegrations(deps: IntegrationDependencies): {
  stop: () => Promise<void>;
} {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const allowedChatId = process.env.TELEGRAM_CHAT_ID?.trim();
  let stopped = false;
  let telegramTimer: NodeJS.Timeout | undefined;
  let scheduleTimer: NodeJS.Timeout | undefined;
  let monitorTimer: NodeJS.Timeout | undefined;
  const telegramRequests = new Set<AbortController>();
  const active = new Set<Promise<void>>();

  const getState = async <T>(key: string): Promise<T | null> => {
    const rows = await deps.query<{ value: T }>(
      "SELECT value FROM integration_state WHERE key=$1",
      [key],
    );
    return rows[0]?.value ?? null;
  };
  const setState = async (key: string, value: unknown): Promise<void> => {
    await deps.query(
      "INSERT INTO integration_state(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      [key, JSON.stringify(value)],
    );
  };
  const deleteState = async (key: string): Promise<void> => {
    await deps.query("DELETE FROM integration_state WHERE key=$1", [key]);
  };
  const listState = async <T>(
    prefix: string,
  ): Promise<{ key: string; value: T }[]> =>
    deps.query<{ key: string; value: T }>(
      "SELECT key,value FROM integration_state WHERE key LIKE $1 ORDER BY key",
      [`${prefix}:%`],
    );

  const track = (work: Promise<void>) => {
    active.add(work);
    void work.catch(() => undefined).finally(() => active.delete(work));
  };
  const later = (
    kind: "telegram" | "schedule" | "monitor",
    callback: () => Promise<void>,
    delay: number,
  ) => {
    if (stopped) return;
    const timer = setTimeout(() => track(callback()), delay);
    timer.unref();
    if (kind === "telegram") telegramTimer = timer;
    else if (kind === "schedule") scheduleTimer = timer;
    else monitorTimer = timer;
  };

  const queueOutbound = async (
    key: string,
    chatId: string,
    text: string,
    markup?: TelegramMarkup,
  ): Promise<void> => {
    const current = await getState<Outbound>(key);
    if (current?.sent) return;
    await setState(
      key,
      current ?? {
        chatId,
        text: truncate(text),
        sent: false,
        createdAt: new Date().toISOString(),
        markup,
      },
    );
  };

  const telegramRequest = async (
    method: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      abort,
      method === "sendMessage" ? 10_000 : 25_000,
    );
    timeout.unref();
    telegramRequests.add(controller);
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      if (!response.ok)
        throw new Error(
          `Telegram ${method} failed with HTTP ${response.status}`,
        );
      const result = (await response.json()) as {
        ok?: boolean;
        result?: unknown;
      };
      if (!result.ok) throw new Error(`Telegram ${method} returned an error`);
      return result.result;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      telegramRequests.delete(controller);
    }
  };

  const flushOutbox = createOutboxDrain(async (): Promise<void> => {
    if (!token) return;
    for (const row of await listState<Outbound>("telegram.outbound")) {
      if (stopped || row.value.sent) continue;
      await telegramRequest("sendMessage", {
        chat_id: row.value.chatId,
        text: row.value.text,
        reply_markup: row.value.markup,
      });
      // Telegram has no send-message idempotency key. A process crash between these
      // two operations can resend one reply; the durable outbox prevents ordinary retries.
      await setState(row.key, { ...row.value, sent: true });
    }
  });

  const ownsRun = async (chatId: string, runId: string): Promise<boolean> => {
    const owner = await getState<{ chatId: string }>(
      stateKey("telegram.run", runId),
    );
    return owner?.chatId === chatId;
  };

  const rememberRun = async (
    chatId: string,
    run: Run,
    updateId: number,
    userText: string,
    agentId?: string,
  ): Promise<void> => {
    const key = stateKey("telegram.conversation", chatId);
    const conversation = (await getState<Conversation>(key)) ?? {
      agentId: agentId ?? "",
      runIds: [],
      turns: [],
    };
    if (agentId) conversation.agentId = agentId;
    if (!conversation.runIds.includes(run.id)) {
      conversation.runIds.push(run.id);
      conversation.turns.push({
        role: "user",
        text: userText,
        at: new Date().toISOString(),
        runId: run.id,
      });
    }
    conversation.turns = conversation.turns.slice(-30);
    await setState(key, conversation);
    const watch = await getState<RunWatch>(stateKey("telegram.run", run.id));
    await setState(
      stateKey("telegram.run", run.id),
      watch ?? ({ chatId, lastNotice: null } satisfies RunWatch),
    );
    const detail = await deps.getRun(run.id);
    if (detail)
      await menu.runCard(
        stateKey("telegram.outbound", `${chatId}:${updateId}:started`),
        chatId,
        detail,
        "Request queued. I’ll reply here when it needs approval or finishes.",
      );
  };

  const conversationPrompt = async (
    chatId: string,
    agentId: string,
    prompt: string,
  ): Promise<string> => {
    const conversation = await getState<Conversation>(
      stateKey("telegram.conversation", chatId),
    );
    let request = prompt;
    if (
      conversation &&
      conversation.agentId === agentId &&
      conversation.turns.length
    ) {
      const prior = conversation.turns
        .slice(-8)
        .map(
          (turn) => `${turn.role === "user" ? "User" : "Agent"}: ${turn.text}`,
        )
        .join("\n");
      request = `Conversation so far:\n${prior}\n\nUser: ${prompt}`;
    }
    return `${request}\n\nTelegram command reference: ${HELP}`;
  };

  const handleUpdate = async (update: TelegramUpdate): Promise<void> => {
    const callback = update.callback_query;
    if (callback) {
      const chatId = callback.message?.chat.id;
      const authorized =
        chatId !== undefined && isAuthorizedChat(allowedChatId!, chatId);
      await telegramRequest("answerCallbackQuery", {
        callback_query_id: callback.id,
        ...(authorized ? {} : { text: "This chat is not authorized." }),
      }).catch(() => undefined);
      if (authorized)
        await menu.callback(String(chatId), update.update_id, callback.data);
      return;
    }
    const message = update.message;
    if (!message?.text || !isAuthorizedChat(allowedChatId!, message.chat.id))
      return;
    const chatId = String(message.chat.id);
    const command = parseTelegramCommand(message.text);
    if (await menu.command(chatId, update.update_id, command)) return;
    const replyKey = (suffix: string) =>
      stateKey("telegram.outbound", `${chatId}:${update.update_id}:${suffix}`);
    if (command.kind === "approve" || command.kind === "reject") {
      if (!(await ownsRun(chatId, command.runId))) {
        await queueOutbound(
          replyKey("denied"),
          chatId,
          "That run does not belong to this Telegram conversation.",
        );
        return;
      }
      const run = await deps.approve(
        command.runId,
        command.kind === "approve",
        command.kind === "reject" ? command.feedback : "",
        command.approvalToken,
      );
      await queueOutbound(
        replyKey("approval"),
        chatId,
        command.kind === "approve"
          ? `Approved run ${run.id}.`
          : `Sent feedback to run ${run.id}.`,
      );
      return;
    }

    let input: EnqueueInput;
    let agentId: string | undefined;
    let pendingImproveKey: string | undefined;
    if (command.kind === "chat") {
      pendingImproveKey = stateKey("telegram.pending-improve", chatId);
      const pending = await getState<PendingImprove>(pendingImproveKey);
      if (pending)
        input = {
          workflowId: pending.workflowId,
          parentRunId: pending.parentRunId,
          prompt: command.prompt,
        };
      else {
        const connected = (await deps.listAgents()).filter(
          (agent) => agent.telegram,
        );
        if (connected.length !== 1) {
          await queueOutbound(
            replyKey("configuration"),
            chatId,
            "Connect exactly one agent to Telegram in OrbitFlow before sending a request.",
          );
          return;
        }
        agentId = connected[0].id;
        input = {
          agentId,
          prompt: await conversationPrompt(chatId, agentId, command.prompt),
        };
      }
    } else if (command.kind === "build")
      input = { workflowId: command.workflowId, prompt: command.prompt };
    else if (command.kind === "improve") {
      const [candidateWorkflowId, candidateRunId, ...advancedPrompt] =
        command.arguments;
      const explicitWorkflow = candidateWorkflowId
        ? await deps.query<{ data: { id: string } }>(
            "SELECT data FROM workflows WHERE id=$1 AND template=false",
            [candidateWorkflowId],
          )
        : [];
      let workflowId: string;
      let parentRunId: string;
      let prompt: string;
      if (explicitWorkflow.length) {
        if (!candidateRunId || !advancedPrompt.length) {
          await queueOutbound(
            replyKey("improve-syntax"),
            chatId,
            "Use /improve <workflow ID> <run ID> <change> for an explicit workflow.",
          );
          return;
        }
        workflowId = candidateWorkflowId!;
        parentRunId = candidateRunId;
        prompt = advancedPrompt.join(" ");
      } else {
        const selection = await selectGuidedImprove(deps.query);
        if ("error" in selection) {
          await queueOutbound(
            replyKey("improve-selection"),
            chatId,
            selection.error,
          );
          return;
        }
        workflowId = selection.workflowId;
        parentRunId = selection.parentRunId;
        prompt = command.arguments.join(" ");
        if (!prompt) {
          await setState(stateKey("telegram.pending-improve", chatId), {
            workflowId,
            parentRunId,
          } satisfies PendingImprove);
          await queueOutbound(
            replyKey("improve-ready"),
            chatId,
            `Ready to improve approved run ${parentRunId}. What would you like to change?`,
          );
          return;
        }
      }
      const source = await deps.getRun(parentRunId);
      const approved =
        source?.run.status === "completed" &&
        source.run.revisionId !== null &&
        source.revisions.some(
          (revision) =>
            revision.id === source.run.revisionId && revision.approved,
        );
      if (!approved) {
        await queueOutbound(
          replyKey("denied"),
          chatId,
          "The source run must be completed and approved in OrbitFlow before it can be improved.",
        );
        return;
      }
      input = {
        workflowId,
        parentRunId,
        prompt,
      };
    } else return;
    input.channel = { chatId, updateId: update.update_id };
    input.idempotencyKey = `telegram:${chatId}:${update.update_id}`;
    const run = await deps.enqueue(input);
    if (pendingImproveKey) await deleteState(pendingImproveKey);
    if (command.kind === "build" || command.kind === "improve")
      await menu.clearPending(chatId);
    await rememberRun(chatId, run, update.update_id, message.text, agentId);
  };

  const menu = createTelegramMenu({
    ...deps,
    getState,
    setState,
    deleteState,
    queueOutbound,
    rememberRun,
    publicOrigin: process.env.PUBLIC_ORIGIN,
  });

  let offset: number | undefined;
  const pollTelegram = async (): Promise<void> => {
    if (stopped || !token || !allowedChatId) return;
    try {
      if (offset === undefined)
        offset =
          (await getState<{ next: number }>("telegram.offset"))?.next ?? 0;
      const result = (await telegramRequest("getUpdates", {
        offset,
        timeout: 20,
        allowed_updates: ["message", "callback_query"],
      })) as TelegramUpdate[];
      for (const update of result.sort((a, b) => a.update_id - b.update_id)) {
        const advanced = advanceTelegramOffset(offset, update.update_id);
        if (advanced.duplicate) continue;
        try {
          await handleUpdate(update);
        } catch (error) {
          // Expected user/configuration races must not poison the durable update queue.
          const message = error instanceof Error ? error.message : "";
          if (
            !/^(Run is not awaiting approval|Approval is missing or stale|Run is missing or already terminal|Workflow not found|One or more agents no longer exist|This workflow requires an approved application|Choose a run with an approved application|Provide a request of)/.test(
              message,
            )
          )
            throw error;
          const chatId =
            update.message?.chat.id ?? update.callback_query?.message?.chat.id;
          if (chatId !== undefined && isAuthorizedChat(allowedChatId!, chatId))
            await queueOutbound(
              stateKey(
                "telegram.outbound",
                `${chatId}:${update.update_id}:error`,
              ),
              String(chatId),
              `${message}. Open /workflows or /runs for current options. /cancel clears a pending request.`,
            );
        }
        offset = advanced.next;
        await setState("telegram.offset", { next: offset });
      }
      await flushOutbox();
    } catch (error) {
      if (
        !stopped &&
        !(error instanceof DOMException && error.name === "AbortError")
      )
        await deps.log(
          null,
          "telegram_error",
          "Telegram polling failed; OrbitFlow will retry without logging credentials.",
        );
    } finally {
      later("telegram", pollTelegram, stopped ? 0 : 1000);
    }
  };

  let nextButtonCleanup = 0;
  const monitorRuns = async (): Promise<void> => {
    if (stopped || !token || !allowedChatId) return;
    try {
      if (Date.now() >= nextButtonCleanup) {
        await menu.pruneButtons();
        nextButtonCleanup = Date.now() + 60 * 60_000;
      }
      for (const row of await listState<RunWatch>("telegram.run")) {
        const runId = decodeURIComponent(row.key.slice("telegram.run:".length));
        const detail = await deps.getRun(runId);
        const notice = `${detail?.run.status}:${detail?.run.updatedAt}`;
        if (
          !detail ||
          !REPORTABLE_STATUSES.has(detail.run.status) ||
          row.value.lastNotice === notice
        )
          continue;
        const suffix = notice;
        await menu.runCard(
          stateKey(
            "telegram.outbound",
            `${row.value.chatId}:${runId}:${suffix}`,
          ),
          row.value.chatId,
          detail,
        );
        await setState(row.key, { ...row.value, lastNotice: notice });
        const conversationKey = stateKey(
          "telegram.conversation",
          row.value.chatId,
        );
        const conversation = await getState<Conversation>(conversationKey);
        if (conversation) {
          conversation.turns.push({
            role: "assistant",
            text: telegramStatusText(detail),
            at: new Date().toISOString(),
            runId,
          });
          conversation.turns = conversation.turns.slice(-30);
          await setState(conversationKey, conversation);
        }
      }
      await flushOutbox();
    } catch {
      if (!stopped)
        await deps.log(
          null,
          "telegram_error",
          "Telegram reply delivery failed; the pending reply was retained for retry.",
        );
    } finally {
      later("monitor", monitorRuns, 2000);
    }
  };

  const wakeSchedule = async (
    agent: Agent,
    state: ScheduleState,
    wakeAt: string,
  ): Promise<void> => {
    if (!agent.schedule.prompt.trim()) {
      await deps.log(
        null,
        "schedule_error",
        `Schedule for agent ${agent.id} has no prompt and was not started.`,
      );
      const latest = await getState<ScheduleState>(
        stateKey("schedule", agent.id),
      );
      if (latest?.pendingAt === wakeAt)
        await setState(stateKey("schedule", agent.id), {
          ...latest,
          pendingAt: undefined,
        });
      return;
    }
    await deps.enqueue({
      ...(agent.schedule.workflowId
        ? { workflowId: agent.schedule.workflowId }
        : { agentId: agent.id }),
      prompt: agent.schedule.prompt,
      idempotencyKey: `schedule:${agent.id}:${wakeAt}`,
      requestSender: `schedule:${agent.id}`,
    });
    const latest = await getState<ScheduleState>(
      stateKey("schedule", agent.id),
    );
    if (latest?.pendingAt === wakeAt)
      await setState(stateKey("schedule", agent.id), {
        ...latest,
        pendingAt: undefined,
      });
  };

  const pollSchedules = async (): Promise<void> => {
    if (stopped) return;
    try {
      const now = new Date();
      for (const agent of await deps.listAgents()) {
        if (stopped || !agent.schedule.enabled) continue;
        const key = stateKey("schedule", agent.id);
        let state = await getState<ScheduleState>(key);
        if (!state || state.expression !== agent.schedule.expression) {
          try {
            state = {
              expression: agent.schedule.expression,
              nextAt: nextScheduleWake(
                agent.schedule.expression,
                now,
              ).toISOString(),
            };
          } catch {
            state = {
              expression: agent.schedule.expression,
              nextAt: null,
              error: "Invalid schedule expression",
            };
            await deps.log(
              null,
              "schedule_error",
              `Schedule for agent ${agent.id} has an invalid expression.`,
            );
          }
          await setState(key, state);
        }
        if (state.pendingAt) {
          await wakeSchedule(agent, state, state.pendingAt);
          continue;
        }
        if (!state.nextAt || new Date(state.nextAt).getTime() > now.getTime())
          continue;
        const wakeAt = state.nextAt;
        let nextAt: string;
        try {
          nextAt = nextScheduleWake(
            agent.schedule.expression,
            now,
          ).toISOString();
        } catch {
          continue;
        }
        state = {
          expression: agent.schedule.expression,
          nextAt,
          pendingAt: wakeAt,
        };
        await setState(key, state);
        await wakeSchedule(agent, state, wakeAt);
      }
    } catch {
      if (!stopped)
        await deps.log(
          null,
          "schedule_error",
          "Schedule polling failed; OrbitFlow will retry.",
        );
    } finally {
      later("schedule", pollSchedules, 1000);
    }
  };

  if (Boolean(token) !== Boolean(allowedChatId))
    track(
      deps.log(
        null,
        "telegram_configuration",
        "Telegram requires both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.",
      ),
    );
  if (token && allowedChatId) {
    track(
      (async () => {
        try {
          await telegramRequest("setMyCommands", {
            commands: telegramCommands,
            scope: { type: "chat", chat_id: allowedChatId },
          });
        } catch {
          if (!stopped)
            await deps.log(
              null,
              "telegram_error",
              "Telegram menu setup failed; typed commands remain available. Setup will retry on restart.",
            );
        }
      })(),
    );
    track(pollTelegram());
    track(monitorRuns());
  }
  track(pollSchedules());

  return {
    stop: async () => {
      stopped = true;
      if (telegramTimer) clearTimeout(telegramTimer);
      if (scheduleTimer) clearTimeout(scheduleTimer);
      if (monitorTimer) clearTimeout(monitorTimer);
      for (const request of telegramRequests) request.abort();
      await Promise.allSettled([...active]);
    },
  };
}
