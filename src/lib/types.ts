import type { IssueStatus, Priority } from "./db/schema";

/**
 * Canonical JSON shapes — the agent contract. Every API read returns `Issue`;
 * every 4xx/5xx returns `ApiErrorBody`. Defined here as the single source of
 * truth so route handlers and tests share one definition.
 */
export interface LabelDTO {
  id: number;
  name: string;
  color: string;
}

export interface IssueDTO {
  id: number;
  identifier: string;
  number: number;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: Priority;
  labels: LabelDTO[];
  blockerIssueIds: number[];
  /**
   * `true` when this issue is on the frontier: status `todo` and every blocker
   * `done`. Mirrors `GET /api/issues/frontier`. This is a derived field, not
   * stored — recomputed on every read.
   */
  ready: boolean;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

export interface ApiErrorBody {
  error: { message: string; code: string | null };
}

/** Input shape for POST /api/issues. */
export interface CreateIssueInput {
  title: unknown;
  description?: unknown;
  status?: unknown;
  priority?: unknown;
  labelNames?: unknown;
}

/** Input shape for PATCH /api/issues/:id. */
export interface UpdateIssueInput {
  title?: unknown;
  description?: unknown;
  status?: unknown;
  priority?: unknown;
}

export interface CreateLabelInput {
  name: unknown;
  color?: unknown;
}
