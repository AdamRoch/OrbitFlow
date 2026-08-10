import Link from "next/link";
import { Badge } from "./ui/badge";
import { CheckIcon } from "./icons";
import { cn } from "@/lib/cn";
import type { IssueDTO, LabelDTO } from "@/lib/types";
import type { IssueStatus, Priority } from "@/lib/db/schema";
import { priorityLabels } from "@/lib/db/schema";
import { STATUS_META, PRIORITY_COLOR } from "@/lib/visual-tokens";

export function StatusBadge({ status }: { status: IssueStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge className="border-[--border] text-[--foreground-muted]">
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: meta.color }}
      />
      {meta.label}
    </Badge>
  );
}

/** Selectable options for status, in canonical-flow order. */
export const STATUS_OPTIONS: { value: IssueStatus; label: string }[] = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In Progress" },
  { value: "done", label: "Done" },
  { value: "canceled", label: "Canceled" },
];

export const PRIORITY_OPTIONS: { value: Priority; label: string }[] = (
  [4, 3, 2, 1, 0] as Priority[]
).map((p) => ({ value: p, label: priorityLabels[p] }));

export function PriorityBadge({ priority }: { priority: Priority }) {
  if (priority === 0) {
    return (
      <span className="text-[--foreground-subtle] text-xs">—</span>
    );
  }
  const meta = PRIORITY_COLOR[priority];
  return (
    <Badge className="border-[--border] text-[--foreground-muted]">
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: meta }}
      />
      {priorityLabels[priority]}
    </Badge>
  );
}

export function LabelChip({ label }: { label: LabelDTO }) {
  return (
    <Badge
      className="border-[--border]"
      style={{
        color: label.color,
        backgroundColor: `${label.color}1a`, // ~10% alpha tint
      }}
    >
      {label.name}
    </Badge>
  );
}

/**
 * Mark a `todo` issue that's held back by an unfinished blocker. We only show
 * this for `todo` issues — a blocked `in_progress`/`done`/`backlog` ticket
 * isn't "ready" for a different reason, and the badge would be noise.
 */
export function BlockedBadge({ issue }: { issue: IssueDTO }) {
  if (issue.status !== "todo" || issue.ready) return null;
  if (issue.blockerIssueIds.length === 0) return null;
  return (
    <Badge className="border-[--border] text-[--foreground-muted]">
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: "#eb5757" }}
      />
      Blocked
    </Badge>
  );
}

export function LabelChips({ labels }: { labels: LabelDTO[] }) {
  if (labels.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {labels.map((l) => (
        <LabelChip key={l.id} label={l} />
      ))}
    </div>
  );
}

/**
 * Per-status row treatment for the list page's mixed-status views (e.g.
 * ?status=all), where rows of every status sit side by side and need to be
 * scannable at a glance. Off by default — the frontier view is all-todo, so
 * tinting would be noise there. Distinct from STATUS_META's badge palette:
 * this is deliberately a green family (todo → done) per product call.
 */
const ROW_STATUS_STYLE: Record<
  IssueStatus,
  { row: string; id: string; glyph?: "check" | "spinner" }
> = {
  todo: {
    row: "border-l-[#4ade80] bg-[#4ade80]/[0.15]",
    id: "text-[#4ade80]",
  },
  in_progress: {
    row: "border-l-[#7c8cff] bg-[#7c8cff]/[0.15]",
    id: "text-[#7c8cff]",
    glyph: "spinner",
  },
  done: {
    row: "border-l-[#1f7a54] bg-[#1f7a54]/[0.30]",
    id: "text-[#3cb88a]",
    glyph: "check",
  },
  backlog: {
    row: "border-l-[#7d8a7e]/60 bg-[#7d8a7e]/[0.10] opacity-75",
    id: "text-[#8a988b]",
  },
  canceled: { row: "opacity-55", id: "" },
};

/** A single row in a list of issues (used by list + frontier views). */
export function IssueRow({
  issue,
  statusStyle = false,
}: {
  issue: IssueDTO;
  /** Tint + glyph the row by status (see ROW_STATUS_STYLE). */
  statusStyle?: boolean;
}) {
  const style = statusStyle ? ROW_STATUS_STYLE[issue.status] : undefined;
  return (
    <Link
      href={`/issues/${issue.identifier}`}
      className={cn(
        "group flex items-center gap-3 rounded-xl border border-[--border] bg-[--surface]/60 px-4 py-3 backdrop-blur-sm transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--accent)_55%,transparent)] hover:bg-[--surface-hover]/80 hover:shadow-[0_14px_34px_-22px_rgba(var(--glow),0.55),0_0_0_1px_color-mix(in_srgb,var(--accent)_35%,transparent),0_0_22px_-6px_rgba(var(--glow),0.6)]",
        style && "border-l-2",
        style?.row,
      )}
    >
      {style && (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {style.glyph === "check" && (
            <CheckIcon className="h-3.5 w-3.5 text-[#3cb88a]" />
          )}
          {style.glyph === "spinner" && (
            <span className="h-3 w-3 animate-spin rounded-full border border-[#7c8cff]/40 border-t-[#7c8cff]" />
          )}
        </span>
      )}
      <span
        className={cn(
          "font-mono text-xs text-[--foreground-subtle] w-20 shrink-0",
          style?.id,
        )}
      >
        {issue.identifier}
      </span>
      <span className="flex-1 truncate text-sm text-[--foreground] transition-colors group-hover:text-white">
        {issue.title}
      </span>
      <div className="flex items-center gap-2 shrink-0">
        {issue.labels.length > 0 && (
          <div className="hidden md:flex items-center gap-1">
            {issue.labels.slice(0, 3).map((l) => (
              <LabelChip key={l.id} label={l} />
            ))}
          </div>
        )}
        <PriorityBadge priority={issue.priority} />
        <BlockedBadge issue={issue} />
        <StatusBadge status={issue.status} />
      </div>
    </Link>
  );
}
