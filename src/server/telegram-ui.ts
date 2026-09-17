import type { RunDetail } from "../shared/types.js";

export type TelegramCommand =
  | { kind: "home" | "workflows" | "agents" | "runs" | "cancel" }
  | { kind: "chat"; prompt: string }
  | { kind: "build"; workflowId: string; prompt: string }
  | { kind: "improve"; arguments: string[] }
  | { kind: "approve"; runId: string; approvalToken: string }
  | { kind: "reject"; runId: string; approvalToken: string; feedback: string }
  | { kind: "status"; runId: string }
  | { kind: "help" }
  | { kind: "invalid"; message: string };

export type TelegramUpdate = {
  update_id: number;
  message?: { text?: string; chat: { id: string | number } };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: string | number } };
  };
};

export type TelegramMarkup = {
  inline_keyboard: (
    { text: string; callback_data: string } | { text: string; url: string }
  )[][];
};

export const telegramCommands = [
  { command: "start", description: "Open the OrbitFlow menu" },
  { command: "workflows", description: "Browse and start saved workflows" },
  { command: "agents", description: "See agents, roles, and models" },
  { command: "runs", description: "View runs started in this chat" },
  { command: "improve", description: "Choose an application to improve" },
  {
    command: "cancel",
    description: "Discard a pending request (does not stop runs)",
  },
  { command: "help", description: "Commands and conversation routing" },
];
export const HELP =
  "Browse /workflows, /agents, or /runs. Choose a workflow and send your request. /improve lets you choose an approved application. /cancel discards a pending request; use Stop run on a run card to stop execution. Plain messages normally go to the Telegram-connected agent; a pending request takes precedence.\n\nAdvanced commands still work: /build <workflow ID> <request>; /improve <workflow ID> <run ID> <change>; /status <run ID>; /approve <run ID> <approval token>; /reject <run ID> <approval token> <feedback>.";
export const REPORTABLE_STATUSES = new Set([
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
]);
export const MAX_TELEGRAM_MESSAGE = 3900;

export function isAuthorizedChat(
  allowedChatId: string,
  actualChatId: string | number,
): boolean {
  return String(actualChatId) === allowedChatId;
}

export function advanceTelegramOffset(
  current: number,
  updateId: number,
): { duplicate: boolean; next: number } {
  return updateId < current
    ? { duplicate: true, next: current }
    : { duplicate: false, next: updateId + 1 };
}

export function parseTelegramCommand(raw: string): TelegramCommand {
  const text = raw.trim();
  if (!text)
    return {
      kind: "invalid",
      message: "Send a request or /help for commands.",
    };
  if (!text.startsWith("/")) return { kind: "chat", prompt: text };
  const [head, ...parts] = text.split(/\s+/);
  const name = head.toLowerCase().replace(/@[^\s]+$/, "");
  if (name === "/help") return { kind: "help" };
  if (name === "/start" || name === "/menu") return { kind: "home" };
  if (["/workflows", "/agents", "/runs", "/cancel"].includes(name))
    return {
      kind: name.slice(1) as "workflows" | "agents" | "runs" | "cancel",
    };
  if (name === "/build") {
    if (!parts.length) return { kind: "workflows" };
    const [workflowId, ...prompt] = parts;
    return workflowId && prompt.length
      ? { kind: "build", workflowId, prompt: prompt.join(" ") }
      : { kind: "invalid", message: "Use /build <workflow ID> <request>." };
  }
  if (name === "/improve") {
    return { kind: "improve", arguments: parts };
  }
  if (name === "/approve")
    return parts.length === 2
      ? { kind: "approve", runId: parts[0], approvalToken: parts[1] }
      : { kind: "invalid", message: "Use /approve <run ID> <approval token>." };
  if (name === "/reject") {
    const [runId, approvalToken, ...feedback] = parts;
    return runId && approvalToken && feedback.length
      ? { kind: "reject", runId, approvalToken, feedback: feedback.join(" ") }
      : {
          kind: "invalid",
          message: "Use /reject <run ID> <approval token> <feedback>.",
        };
  }
  if (name === "/status" && !parts.length) return { kind: "runs" };
  if (name === "/status")
    return parts.length === 1
      ? { kind: "status", runId: parts[0] }
      : { kind: "invalid", message: "Use /status <run ID>." };
  return {
    kind: "invalid",
    message: "Unknown command. Send /help for commands.",
  };
}

export function telegramStatusText(detail: RunDetail): string {
  const { run } = detail;
  const usage =
    run.costUsd === null
      ? `${run.inputTokens + run.outputTokens} tokens; cost unavailable`
      : `${run.inputTokens + run.outputTokens} tokens; $${run.costUsd.toFixed(4)}`;
  if (run.status === "awaiting_approval")
    return detail.approvalToken
      ? `Run ${run.id} is awaiting ${detail.approvalKind === "turn" ? "permission for the next agent turn" : "approval of this revision"}. ${detail.approvalKind === "turn" ? "Inspect its agent and request in OrbitFlow." : "Review its source and preview in OrbitFlow."} Use the buttons below, or /approve ${run.id} ${detail.approvalToken}. Usage: ${usage}.`
      : `Run ${run.id} is awaiting approval, but its approval token is unavailable. Refresh the run in OrbitFlow. Usage: ${usage}.`;
  if (run.status === "completed") {
    const response = [...detail.messages]
      .reverse()
      .find((message) => message.content.trim())
      ?.content.trim();
    const artifact = run.revisionId
      ? " Its retained source and preview are ready in OrbitFlow."
      : "";
    return `${response ? `${response}\n\n` : ""}Run ${run.id} completed.${artifact} Usage: ${usage}.`;
  }
  if (run.status === "failed")
    return `Run ${run.id} failed. Open OrbitFlow for the recorded error. Usage: ${usage}.`;
  if (run.status === "cancelled")
    return `Run ${run.id} was cancelled. Usage: ${usage}.`;
  return `Run ${run.id}: ${run.status}. Current workflow node: ${run.currentNode ?? "none"}. Usage: ${usage}.`;
}
