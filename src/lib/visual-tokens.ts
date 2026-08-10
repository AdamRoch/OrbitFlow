import type { IssueStatus, Priority } from "@/lib/db/schema";

/**
 * The single source of truth for status + priority colors across the UI.
 *
 * Used by the status/priority badges (issue rows, detail page) and by the
 * graph canvas nodes + minimap. Kept as literal hexes (not CSS vars) because
 * these colors are consumed both as inline `style` (badges, node borders) and
 * as values ReactFlow needs to read at runtime (minimap nodeColor). The design
 * tokens in globals.css are about surface/foreground/accent; these are a
 * separate semantic palette keyed by enum value.
 */

export const STATUS_META: Record<
  IssueStatus,
  { color: string; label: string }
> = {
  backlog: { color: "#6c6e76", label: "Backlog" },
  todo: { color: "#e2b65d", label: "Todo" },
  in_progress: { color: "#5e6ad2", label: "In Progress" },
  done: { color: "#4cb782", label: "Done" },
  canceled: { color: "#eb5757", label: "Canceled" },
};

export const PRIORITY_COLOR: Record<Priority, string> = {
  0: "#6c6e76",
  1: "#9b9da3",
  2: "#5e6ad2",
  3: "#e2b65d",
  4: "#eb5757",
};
