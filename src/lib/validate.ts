import { issueStatuses, priorities, type IssueStatus, type Priority } from "./db/schema";

/**
 * Validation for API inputs. Each helper either returns the validated value or
 * throws `ValidationError`, which the route layer maps to a 400 with the stable
 * error shape. Keeping validation here means the rules live in one place and
 * are reusable from both the API and any future server actions.
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

const STATUS_SET = new Set<string>(issueStatuses);
const PRIORITY_SET = new Set<number>(priorities);

const HEX_COLOR = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

/** A non-empty trimmed string. Empty/whitespace → 400. */
export function requireTitle(value: unknown, field = "title"): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string`, "invalid_type");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(`${field} must not be empty`, "empty");
  }
  return trimmed;
}

/** `null` clears the description; a string is trimmed of trailing whitespace. */
export function optionalDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ValidationError("description must be a string", "invalid_type");
  }
  return value.length === 0 ? null : value;
}

export function parseStatus(value: unknown): IssueStatus {
  if (value === undefined || value === null) {
    throw new ValidationError("status is required", "missing");
  }
  if (typeof value !== "string" || !STATUS_SET.has(value)) {
    throw new ValidationError(
      `status must be one of: ${issueStatuses.join(", ")}`,
      "invalid_status",
    );
  }
  return value as IssueStatus;
}

export function parseOptionalStatus(value: unknown): IssueStatus | undefined {
  if (value === undefined || value === null) return undefined;
  return parseStatus(value);
}

export function parsePriority(value: unknown): Priority {
  if (value === undefined || value === null) {
    throw new ValidationError("priority is required", "missing");
  }
  // Accept numbers or numeric strings; reject booleans (typeof true === ...).
  const n = typeof value === "number" ? value : Number(value);
  if (typeof value === "boolean" || !Number.isFinite(n) || !PRIORITY_SET.has(n)) {
    throw new ValidationError(
      `priority must be one of: ${priorities.join(", ")}`,
      "invalid_priority",
    );
  }
  return n as Priority;
}

export function parseOptionalPriority(value: unknown): Priority | undefined {
  if (value === undefined || value === null) return undefined;
  return parsePriority(value);
}

export function parseLabelNames(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError("labelNames must be an array", "invalid_type");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new ValidationError("labelNames must contain only strings", "invalid_type");
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) continue; // tolerate empty entries
    if (seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  }
  return out;
}

export function parseColor(value: unknown): string {
  const fallback = "#6b7280";
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !HEX_COLOR.test(value.trim())) {
    throw new ValidationError(
      "color must be a hex color like #aabbcc",
      "invalid_color",
    );
  }
  return value.trim();
}

export function parseLabelName(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError("name must be a string", "invalid_type");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("name must not be empty", "empty");
  }
  return trimmed;
}
