"use client";

import { useCallback, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { IssueStatus, Priority } from "@/lib/db/schema";
import type { LabelDTO } from "@/lib/types";
import { cn } from "@/lib/cn";
import { STATUS_OPTIONS, PRIORITY_OPTIONS } from "./issue-display";

/**
 * Filter bar for the ticket list. A small client component so controls can
 * auto-navigate on change (preserving sibling filters). Each change rewrites
 * the URL query params, which re-renders the server component list.
 *
 * Status is one control: a dropdown with every status plus "Any"
 * (?status=all). Hovering (or keyboard-focusing) the dropdown reveals the
 * two most common picks — To Do (the default, clears the param) and In
 * Progress — as quick buttons floating beneath it, so the bar stays quiet
 * until you reach for it.
 */
/**
 * Single-key status shortcuts (no modifiers — the GitHub/Linear pattern).
 * `undefined` clears the param, i.e. the To Do default. Deliberately NOT
 * Ctrl/Cmd combos: those collide with browser chrome (save, bookmark,
 * select-all) and OS shortcuts.
 */
const STATUS_KEYS: Record<string, string | undefined> = {
  a: "all",
  t: undefined,
  i: "in_progress",
  d: "done",
  b: "backlog",
  c: "canceled",
};

export function FilterBar({
  labels,
  current,
}: {
  labels: LabelDTO[];
  current: { status?: IssueStatus; priority?: Priority; label?: string };
}) {
  const router = useRouter();
  const params = useSearchParams();
  const hasFilters = Boolean(
    current.priority ||
      current.label ||
      (current.status && current.status !== "todo"),
  );

  const navigate = useCallback(
    (overrides: Record<string, string | undefined>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(overrides)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      const qs = next.toString();
      router.push(qs ? `/?${qs}` : "/");
    },
    [params, router],
  );

  // Single-key status shortcuts, scoped to this page because FilterBar only
  // renders on "/". Ignored while typing in any field or when a modifier is
  // held, so real typing and browser/OS shortcuts are never hijacked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      if (!(key in STATUS_KEYS)) return;
      navigate({ status: STATUS_KEYS[key] });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const selectClass =
    "h-9 rounded-full border border-[--border] bg-[--surface-2]/70 px-3 text-sm text-[--foreground] backdrop-blur-sm focus:outline-none focus:border-[--accent] cursor-pointer transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]";

  const quickClass = (active: boolean) =>
    cn(
      "h-7 rounded-full border px-2.5 text-xs backdrop-blur-sm cursor-pointer transition-colors",
      active
        ? "border-[--accent] bg-[--surface-2]/90 text-[--foreground]"
        : "border-[--border] bg-[--surface-2]/90 text-[--foreground-muted] hover:text-[--foreground] hover:border-[--accent]",
    );

  return (
    // NOTE: relative z-20 keeps the floating quick picks / cheat sheet above
    // sibling content inside the bar's Reveal wrapper. The decisive stacking
    // fix lives in page.tsx: the FilterBar's <Reveal> itself carries
    // "relative z-20", because .reveal sets will-change: transform (a
    // permanent stacking context) and the ticket-panel Reveal comes later in
    // DOM order — inner z-indexes can't escape that.
    <div className="glass glow-edge relative z-20 flex flex-wrap items-end gap-3 mb-5 rounded-2xl p-3">
      <div className="group relative flex flex-col gap-1">
        <label className="text-xs text-[--foreground-muted]">Status</label>
        <select
          className={selectClass}
          value={current.status ?? "all"}
          onChange={(e) => {
            const v = e.target.value;
            navigate({ status: v === "todo" ? undefined : v });
          }}
        >
          <option value="all">Any</option>
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        {/* Quick picks for the two most common statuses. Hidden until the
            control is hovered or focused (focus-within keeps it keyboard-
            accessible); absolutely positioned so nothing reflows. */}
        <div className="invisible absolute left-0 top-full z-10 mt-1 flex gap-1 opacity-0 transition-all duration-200 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
          <button
            type="button"
            onClick={() => navigate({ status: undefined })}
            className={quickClass(current.status === "todo")}
          >
            To do <Kbd>t</Kbd>
          </button>
          <button
            type="button"
            onClick={() => navigate({ status: "in_progress" })}
            className={quickClass(current.status === "in_progress")}
          >
            In progress <Kbd>i</Kbd>
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-[--foreground-muted]">Priority</label>
        <select
          className={selectClass}
          value={current.priority !== undefined ? String(current.priority) : ""}
          onChange={(e) =>
            navigate({ priority: e.target.value || undefined })
          }
        >
          <option value="">Any</option>
          {PRIORITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-[--foreground-muted]">Label</label>
        <select
          className={selectClass}
          value={current.label ?? ""}
          onChange={(e) => navigate({ label: e.target.value || undefined })}
        >
          <option value="">Any</option>
          {labels.map((l) => (
            <option key={l.id} value={l.name}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      {hasFilters && (
        <button
          type="button"
          onClick={() => router.push("/")}
          className="h-9 px-3 inline-flex items-center text-sm text-[--foreground-muted] rounded-full hover:text-[--foreground] hover:bg-[--surface-hover] transition-colors"
        >
          Clear
        </button>
      )}

      {/* Shortcut cheat sheet, revealed on hover/focus of the "?" chip —
          same no-JS pattern as the status quick picks. */}
      <div className="group relative ml-auto">
        <button
          type="button"
          aria-label="Keyboard shortcuts"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-[--border] bg-[--surface-2]/70 text-xs text-[--foreground-subtle] backdrop-blur-sm cursor-help transition-colors hover:text-[--foreground] hover:border-[--accent]"
        >
          ?
        </button>
        <div className="invisible absolute right-0 top-full z-10 mt-1 w-52 rounded-xl border border-[--border] bg-[--surface-2]/95 p-3 text-xs text-[--foreground-muted] opacity-0 shadow-lg backdrop-blur-sm transition-all duration-200 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
          <p className="mb-2 font-medium text-[--foreground]">
            Status shortcuts
          </p>
          <ul className="flex flex-col gap-1">
            <li className="flex items-center justify-between">
              Any <Kbd>a</Kbd>
            </li>
            <li className="flex items-center justify-between">
              To do <Kbd>t</Kbd>
            </li>
            <li className="flex items-center justify-between">
              In progress <Kbd>i</Kbd>
            </li>
            <li className="flex items-center justify-between">
              Done <Kbd>d</Kbd>
            </li>
            <li className="flex items-center justify-between">
              Backlog <Kbd>b</Kbd>
            </li>
            <li className="flex items-center justify-between">
              Canceled <Kbd>c</Kbd>
            </li>
          </ul>
          <p className="mt-2 text-[--foreground-subtle]">
            Single keys, no modifiers. Ignored while typing in a field.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Tiny key-cap badge used by the shortcut hints. */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-[--border] bg-[--surface] px-1 font-mono text-[10px] text-[--foreground-subtle]">
      {children}
    </kbd>
  );
}
