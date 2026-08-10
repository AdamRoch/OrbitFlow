import { NextResponse } from "next/server";
import type { DB } from "./db";
import { getDefaultProject } from "./db";
import type { ProjectRow } from "./db/schema";
import type { ApiErrorBody } from "./types";
import { ValidationError } from "./validate";

/**
 * Shared HTTP helpers for the REST API. Every response goes through these so
 * the JSON shapes (success + the canonical error envelope) stay uniform —
 * which is what makes the API a reliable contract for agents.
 */

/** 200/201 with a JSON body. */
export function ok<T>(body: T, status: 200 | 201 = 200): NextResponse {
  return NextResponse.json(body, { status });
}

/** 204 No Content. */
export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

/** Build the canonical error envelope: `{ error: { message, code } }`. */
export function errorBody(message: string, code: string | null = null): ApiErrorBody {
  return { error: { message, code } };
}

/** 400 with the canonical error shape. */
export function badRequest(message: string, code: string | null = null): NextResponse {
  return NextResponse.json(errorBody(message, code), { status: 400 });
}

/** 404 with the canonical error shape. */
export function notFound(message = "not found"): NextResponse {
  return NextResponse.json(errorBody(message, "not_found"), { status: 404 });
}

/** 409 with the canonical error shape. */
export function conflict(message: string, code: string | null = null): NextResponse {
  return NextResponse.json(errorBody(message, code), { status: 409 });
}

/**
 * Map a thrown domain/validation error to an HTTP response. Unknown errors
 * become a generic 500 with a stable envelope (the message is logged server-
 * side but not leaked verbatim in production).
 */
export function handleError(err: unknown): NextResponse {
  if (err instanceof ValidationError) {
    return badRequest(err.message, err.code);
  }
  if (err instanceof SyntaxError) {
    // Malformed JSON body.
    return badRequest("request body must be valid JSON", "invalid_json");
  }
  // Surface a stable envelope; print the real error for the operator.
  console.error("[api] unhandled error:", err);
  return NextResponse.json(
    errorBody("internal server error", "internal"),
    { status: 500 },
  );
}

/** Parse and validate a JSON request body. Throws SyntaxError on bad JSON. */
export async function parseJson<T = unknown>(req: Request): Promise<T> {
  const text = await req.text();
  if (text.length === 0) return {} as T;
  return JSON.parse(text) as T;
}

/**
 * Shared route-handler context shape. Next.js async `params` are a Promise over
 * the dynamic segments. The default covers the common single-segment `:id`;
 * pass a narrower shape for multi-segment routes (e.g. `{ id; blockerId }`).
 */
export interface RouteContext<
  T extends Record<string, string> = { id: string },
> {
  params: Promise<T>;
}

/**
 * Resolve OrbitFactory's internal ticket scope. FACT-6 will replace this
 * temporary SQLite boundary with the application PostgreSQL schema.
 */
export function requireProject(db: DB): ProjectRow {
  const project = getDefaultProject(db);
  if (!project) {
    throw new ValidationError("ticket scope is unavailable", "project_not_found");
  }
  return project;
}
