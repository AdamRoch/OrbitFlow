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
