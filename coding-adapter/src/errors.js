// Public failure codes for the executable coding tool. Anything else is
// reported as internal_failure.
export const PUBLIC_ERROR_CODES = new Set([
  "internal_failure",
  "missing_credentials",
  "cli_failure",
  "timeout",
  "malformed_output",
  "output_too_large",
  "credential_exposure",
  "workspace_invalid",
  "persistence_failure",
  "invalid_request",
]);

export function createPublicErrorResponse(error) {
  const code = PUBLIC_ERROR_CODES.has(error?.code) ? error.code : "internal_failure";
  const result = {
    code,
    message:
      typeof error?.message === "string"
        ? error.message.slice(0, 1_000)
        : "coding tool failed",
  };
  if (Number.isInteger(error?.exitCode)) result.exitCode = error.exitCode;
  if (typeof error?.signal === "string") result.signal = error.signal;
  if (Number.isInteger(error?.timeoutMs) && error.timeoutMs > 0) {
    result.timeoutMs = error.timeoutMs;
  }
  if (Number.isInteger(error?.limitBytes) && error.limitBytes > 0) {
    result.limitBytes = error.limitBytes;
  }
  if (typeof error?.stderrTail === "string") {
    result.stderrTail = error.stderrTail.slice(-4_000);
  }
  if (typeof error?.stdoutTail === "string") {
    result.stdoutTail = error.stdoutTail.slice(-4_000);
  }
  if (typeof error?.rawTail === "string") result.rawTail = error.rawTail.slice(-500);
  if (typeof error?.varName === "string") result.varName = error.varName;
  return result;
}

// Structured failure types for delegate_coding_task. Never carry secret values,
// only bounded tails of process output and (for missing creds) the env var name.

export class MissingCredentialsError extends Error {
  constructor(varName) {
    super(`missing required credential env var: ${varName}`);
    this.name = "MissingCredentialsError";
    this.code = "missing_credentials";
    this.varName = varName;
  }
}

export class CliFailureError extends Error {
  constructor(message, { exitCode = null, signal = null, stderrTail = "", stdoutTail = "" } = {}) {
    super(message);
    this.name = "CliFailureError";
    this.code = "cli_failure";
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderrTail = stderrTail;
    this.stdoutTail = stdoutTail;
  }
}

export class TimeoutError extends Error {
  constructor(timeoutMs) {
    super(`coding CLI timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.code = "timeout";
    this.timeoutMs = timeoutMs;
  }
}

export class MalformedOutputError extends Error {
  constructor(message, { rawTail = "" } = {}) {
    super(message);
    this.name = "MalformedOutputError";
    this.code = "malformed_output";
    this.rawTail = rawTail;
  }
}

export class OutputTooLargeError extends Error {
  constructor(limitBytes) {
    super(`workspace diff exceeded the ${limitBytes}-byte output limit`);
    this.name = "OutputTooLargeError";
    this.code = "output_too_large";
    this.limitBytes = limitBytes;
  }
}

export class CredentialExposureError extends Error {
  constructor(message) {
    super(message);
    this.name = "CredentialExposureError";
    this.code = "credential_exposure";
  }
}

export class WorkspaceError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceError";
    this.code = "workspace_invalid";
  }
}

export class PersistenceError extends Error {
  constructor(message = "failed to persist coding-tool usage") {
    super(message);
    this.name = "PersistenceError";
    this.code = "persistence_failure";
  }
}

export class InvalidRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidRequestError";
    this.code = "invalid_request";
  }
}
