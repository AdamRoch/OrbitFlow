import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const OPENCLAW_MODEL = "openrouter/openai/gpt-4.1-mini";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_MODEL = "openai/gpt-4.1-mini";

const GENERATED_OPENROUTER_BASE_URL = "https://openrouter.ai/v1";
const DIAGNOSTIC_PROMPT = "Reply with exactly OK. Do not use tools.";
const DIAGNOSTIC_SESSION_ID = "fact-1-openrouter-diagnostic";
const FAILED_DIAGNOSTIC_CAPTURE_TIMEOUT_MS = 150_000;

export const AGENT_DEFINITIONS = [
  {
    id: "fact-scout",
    name: "Mira",
    emoji: "🔎",
    theme: "skeptical systems scout",
    persona:
      "You are Mira, a skeptical systems scout. You state concrete evidence first, call out uncertainty, and keep answers terse.",
    memoryFact: "The durable launch phrase is amber-lattice.",
  },
  {
    id: "fact-reviewer",
    name: "Rowan",
    emoji: "🧭",
    theme: "calm reliability reviewer",
    persona:
      "You are Rowan, a calm reliability reviewer. You look for failure boundaries, distinguish proof from inference, and keep answers terse.",
    memoryFact: "The durable safety phrase is cobalt-anchor.",
  },
];

export class OpenClawContractError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OpenClawContractError";
    this.details = details;
  }
}

export function parseCliJson(stdout) {
  const lines = String(stdout).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const firstCharacter = lines[index].trimStart()[0];
    if (firstCharacter !== "{" && firstCharacter !== "[") continue;
    const candidate = lines.slice(index).join("\n").trim();
    try {
      return JSON.parse(candidate);
    } catch {
      // A diagnostic line can begin with a brace. Keep looking for the JSON document.
    }
  }
  throw new OpenClawContractError("OpenClaw did not emit a JSON document");
}

export function parseCommandJson(result) {
  try {
    return parseCliJson(result.stdout);
  } catch (stdoutError) {
    try {
      return parseCliJson(result.stderr);
    } catch {
      throw new OpenClawContractError("OpenClaw did not emit a JSON document", {
        stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
        stderrBytes: Buffer.byteLength(result.stderr ?? ""),
        stdoutError: stdoutError.message,
      });
    }
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OpenClawContractError(`Agent output field ${field} must be a non-empty string`);
  }
  return value;
}

export function parseOutputContract(text) {
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  let output;
  try {
    output = JSON.parse(candidate);
  } catch (error) {
    throw new OpenClawContractError("Agent final output is not strict JSON", {
      cause: error.message,
    });
  }

  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new OpenClawContractError("Agent final output must be a JSON object");
  }
  if (!output.artifact || typeof output.artifact !== "object" || Array.isArray(output.artifact)) {
    throw new OpenClawContractError("Agent output artifact must be an object");
  }
  requireString(output.artifact.agent, "artifact.agent");
  requireString(output.artifact.persona, "artifact.persona");
  requireString(output.artifact.memory_fact, "artifact.memory_fact");
  requireString(output.artifact.observation, "artifact.observation");
  requireString(output.handoff_brief, "handoff_brief");
  if (!Array.isArray(output.events)) {
    throw new OpenClawContractError("Agent output events must be an array");
  }
  return output;
}

function expectedMemoryPhrase(agent) {
  return agent.memoryFact
    .replace(/^The durable (?:launch|safety) phrase is /, "")
    .replace(/\.$/, "");
}

function matchesExpectedMemory(agent, reportedMemory) {
  return reportedMemory === expectedMemoryPhrase(agent) || reportedMemory === agent.memoryFact;
}

export function validateAgentProof({ agent, output, injectedWorkspaceFiles }) {
  const expectedFiles = ["IDENTITY.md", "MEMORY.md", "SOUL.md"];
  const validation = {
    agentIdentity: output.artifact.agent === agent.name,
    personaTheme: output.artifact.persona === agent.theme,
    persistentMemory: matchesExpectedMemory(agent, output.artifact.memory_fact),
    completeWorkspaceInjection: expectedFiles.every((name) => {
      const file = injectedWorkspaceFiles.find((candidate) => candidate.name === name);
      return (
        file?.missing === false &&
        file.truncated === false &&
        Number.isInteger(file.rawChars) &&
        file.rawChars > 0 &&
        file.injectedChars === file.rawChars
      );
    }),
  };
  const failed = Object.entries(validation).filter(([, passed]) => !passed);
  if (failed.length > 0) {
    throw new OpenClawContractError(
      `${agent.id} failed agent proof: ${failed.map(([name]) => name).join(", ")}`,
    );
  }
  return validation;
}

export function normalizeUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== "object") {
    throw new OpenClawContractError("OpenClaw omitted per-turn token usage");
  }
  const input = Number(rawUsage.input ?? rawUsage.inputTokens ?? 0);
  const output = Number(rawUsage.output ?? rawUsage.outputTokens ?? 0);
  const cacheRead = Number(rawUsage.cacheRead ?? rawUsage.cacheReadTokens ?? 0);
  const cacheWrite = Number(rawUsage.cacheWrite ?? rawUsage.cacheWriteTokens ?? 0);
  const total = Number(rawUsage.total ?? input + output);
  for (const [field, value] of Object.entries({ input, output, cacheRead, cacheWrite, total })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new OpenClawContractError(`OpenClaw returned invalid usage.${field}`);
    }
  }
  if (total === 0) {
    throw new OpenClawContractError("OpenClaw returned zero total tokens for a completed turn");
  }
  return { input, output, cacheRead, cacheWrite, total };
}

export function parseTurnResult(result) {
  if (result.timedOut) {
    throw new OpenClawContractError("OpenClaw turn timed out", { signal: result.signal });
  }

  const envelope = parseCommandJson(result);

  // Current official `agent exec --json` stable envelope.
  if (Object.hasOwn(envelope, "ok") && Object.hasOwn(envelope, "status")) {
    if (result.exitCode !== 0 || envelope.ok !== true || envelope.status !== "ok") {
      throw new OpenClawContractError("OpenClaw stable turn envelope is not complete", {
        exitCode: result.exitCode,
        status: envelope.status,
        error: envelope.error?.kind ?? null,
      });
    }
    const finalText = requireString(envelope.final ?? envelope.payloads?.[0]?.text, "final");
    return {
      envelope,
      output: parseOutputContract(finalText),
      usage: normalizeUsage(envelope.usage),
      completion: { status: envelope.status, exitCode: result.exitCode },
      runtime: {
        sessionId: envelope.sessionId ?? null,
        provider: envelope.provider ?? null,
        model: envelope.model ?? null,
      },
    };
  }

  // OpenClaw 2026.4.15 `agent --local --json` envelope.
  const meta = envelope.meta;
  if (!meta || typeof meta !== "object") {
    throw new OpenClawContractError("OpenClaw legacy turn envelope omitted meta");
  }
  const stopReason = meta.stopReason ?? meta.completion?.finishReason ?? null;
  if (
    result.exitCode !== 0 ||
    meta.error ||
    meta.aborted === true ||
    meta.livenessState === "blocked" ||
    stopReason !== "stop"
  ) {
    throw new OpenClawContractError("OpenClaw legacy turn did not complete successfully", {
      exitCode: result.exitCode,
      livenessState: meta.livenessState ?? null,
      stopReason,
      error: meta.error?.kind ?? null,
    });
  }
  const finalText = requireString(envelope.payloads?.[0]?.text, "payloads[0].text");
  const agentMeta = meta.agentMeta ?? {};
  return {
    envelope,
    output: parseOutputContract(finalText),
    usage: normalizeUsage(agentMeta.usage ?? agentMeta.lastCallUsage),
    completion: {
      status: stopReason,
      exitCode: result.exitCode,
    },
    runtime: {
      sessionId: agentMeta.sessionId ?? null,
      provider: agentMeta.provider ?? null,
      model: agentMeta.model ?? null,
    },
  };
}

export function composePrompt(agent) {
  return [
    "# Workflow context",
    "OrbitFlow is testing whether OpenClaw can execute deterministic workflow nodes.",
    "",
    "# Assigned task",
    `Identify yourself as ${agent.name}, describe your configured persona in one short phrase, and report the durable phrase from your workspace memory.`,
    "Do not use tools. Do not invent a phrase that is absent from memory.",
    "",
    "# Upstream handoff brief",
    "This is an isolated runtime proof. Separate direct evidence from inference.",
    "",
    "# Output contract",
    "Return only one JSON object with this exact shape:",
    '{"artifact":{"agent":"string","persona":"string","memory_fact":"string","observation":"string"},"handoff_brief":"string","events":[]}',
    "Do not wrap the JSON in Markdown fences.",
  ].join("\n");
}

export async function runProcess(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = 180_000,
    stopWhen,
  } = options;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stoppedEarly = false;
    let forceKillTimer;
    const stopIfMatched = () => {
      if (!stoppedEarly && stopWhen?.({ stdout, stderr })) {
        stoppedEarly = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      stopIfMatched();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      stopIfMatched();
    });
    child.on("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      resolve({ exitCode, signal, timedOut, stoppedEarly, stdout, stderr });
    });
  });
}

export async function runOpenClaw(
  args,
  { stateDir, timeoutMs = 180_000, env: envOverrides = {}, stopWhen } = {},
) {
  const result = await runProcess("openclaw", ["--no-color", ...args], {
    env: { ...process.env, ...envOverrides, OPENCLAW_STATE_DIR: stateDir },
    timeoutMs,
    stopWhen,
  });
  return result;
}

async function requireSuccessfulJsonCommand(args, options) {
  const result = await runOpenClaw(args, options);
  if (result.timedOut || result.exitCode !== 0) {
    throw new OpenClawContractError(`OpenClaw command failed: ${args.slice(0, 3).join(" ")}`, {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stderr: result.stderr.slice(-500),
    });
  }
  return { result, json: parseCommandJson(result) };
}

async function requireSuccessfulCommand(args, options) {
  const result = await runOpenClaw(args, options);
  if (result.timedOut || result.exitCode !== 0) {
    throw new OpenClawContractError(`OpenClaw command failed: ${args.slice(0, 3).join(" ")}`, {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stderr: result.stderr.slice(-500),
    });
  }
  return result;
}

async function writeAgentWorkspace(workspaceDir, agent) {
  await mkdir(workspaceDir, { recursive: true });
  const files = {
    "AGENTS.md": "Follow SOUL.md. Read MEMORY.md before answering. Return the user's requested output contract exactly.\n",
    "SOUL.md": `${agent.persona}\n`,
    "IDENTITY.md": `# ${agent.name}\n\n- Name: ${agent.name}\n- Emoji: ${agent.emoji}\n- Theme: ${agent.theme}\n`,
    "MEMORY.md": `# Durable memory\n\n${agent.memoryFact}\n`,
    "USER.md": "# User\n\nThe user is running a bounded execution-plane proof.\n",
    "TOOLS.md": "# Tools\n\nNo tools are needed for this proof.\n",
    "HEARTBEAT.md": "# Heartbeat\n\nNo scheduled work.\n",
  };
  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(path.join(workspaceDir, name), contents)),
  );
  return files;
}

export async function setConfig(stateDir, configPath, value) {
  const result = await runOpenClaw(
    ["config", "set", configPath, JSON.stringify(value), "--strict-json"],
    { stateDir, timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0 || result.timedOut) {
    throw new OpenClawContractError(`Failed to configure ${configPath}`, {
      exitCode: result.exitCode,
      stderr: result.stderr.slice(-500),
    });
  }
}

function openRouterProviderConfig(baseUrl) {
  return {
    baseUrl,
    api: "openai-completions",
    models: [
      {
        id: OPENROUTER_MODEL,
        name: "OpenAI GPT-4.1 Mini",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_047_576,
        maxTokens: 32_768,
      },
    ],
  };
}

export async function initializeOpenClaw(runtimeDir) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new OpenClawContractError("Missing required credential source: OPENROUTER_API_KEY");
  }
  const stateDir = path.join(runtimeDir, "state");
  const mainWorkspace = path.join(runtimeDir, "main-workspace");
  await mkdir(stateDir, { recursive: true });
  await mkdir(mainWorkspace, { recursive: true });

  const onboard = await requireSuccessfulJsonCommand(
    [
      "onboard",
      "--non-interactive",
      "--accept-risk",
      "--mode",
      "local",
      "--auth-choice",
      "openrouter-api-key",
      "--secret-input-mode",
      "ref",
      "--workspace",
      mainWorkspace,
      "--gateway-bind",
      "loopback",
      "--no-install-daemon",
      "--skip-channels",
      "--skip-skills",
      "--skip-ui",
      "--skip-health",
      "--json",
    ],
    { stateDir, timeoutMs: 60_000 },
  );

  await setConfig(stateDir, "agents.defaults.model.primary", OPENCLAW_MODEL);
  await setConfig(stateDir, `agents.defaults.models[${OPENCLAW_MODEL}]`, {});
  await requireSuccessfulJsonCommand(["models", "status", "--agent", "main", "--json"], {
    stateDir,
    timeoutMs: 30_000,
  });
  const generatedOpenRouterBaseUrl = await readGeneratedOpenRouterBaseUrl(stateDir);
  if (generatedOpenRouterBaseUrl !== GENERATED_OPENROUTER_BASE_URL) {
    throw new OpenClawContractError(
      `Installed OpenClaw did not reproduce the expected generated OpenRouter base URL: ${generatedOpenRouterBaseUrl}`,
    );
  }
  await setConfig(stateDir, "models.mode", "replace");
  await setConfig(
    stateDir,
    "models.providers.openrouter",
    openRouterProviderConfig(generatedOpenRouterBaseUrl),
  );
  await setConfig(stateDir, "tools.profile", "minimal");
  return { stateDir, onboard: onboard.json, generatedOpenRouterBaseUrl };
}

async function listFiles(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(currentDir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(rootDir, absolute)));
    else files.push(path.relative(rootDir, absolute));
  }
  return files.sort();
}

async function hashDirectory(rootDir) {
  const hash = createHash("sha256");
  for (const file of await listFiles(rootDir)) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(path.join(rootDir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readGeneratedOpenRouterBaseUrl(stateDir) {
  const modelFiles = (await listFiles(stateDir)).filter((file) => file.endsWith("models.json"));
  for (const file of modelFiles) {
    const contents = JSON.parse(await readFile(path.join(stateDir, file), "utf8"));
    const baseUrl = contents.providers?.openrouter?.baseUrl;
    if (typeof baseUrl === "string" && baseUrl.length > 0) return baseUrl;
  }
  throw new OpenClawContractError("OpenClaw did not generate an OpenRouter models.json entry");
}

export function parseOpenAiRequestLog(result) {
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const pattern =
    /\]\s+(post)\s+(https:\/\/[^\s]+)\s+(succeeded|failed)\s+with status\s+(\d{3})/gi;
  const matches = [...combined.matchAll(pattern)]
    .map((match) => {
      const url = new URL(match[2]);
      return {
        method: match[1].toUpperCase(),
        origin: url.origin,
        path: `${url.pathname}${url.search}`,
        httpStatus: Number(match[4]),
        outcome: match[3],
      };
    })
    .filter((request) => request.origin === "https://openrouter.ai");
  if (matches.length === 0) {
    throw new OpenClawContractError("OpenClaw did not emit an authoritative OpenAI SDK request log");
  }
  return matches.at(-1);
}

function parseFailedOpenClawDiagnosticProbe(result, { configuration, authProfile }) {
  if (result.timedOut || !result.stoppedEarly) {
    throw new OpenClawContractError("OpenClaw failure request was not captured within its bound");
  }
  const request = parseOpenAiRequestLog(result);
  const expectedRequest = new URL(
    "chat/completions",
    `${configuration.baseUrl.replace(/\/$/, "")}/`,
  );
  if (
    request.method !== "POST" ||
    request.origin !== expectedRequest.origin ||
    request.path !== `${expectedRequest.pathname}${expectedRequest.search}` ||
    request.httpStatus !== 404
  ) {
    throw new OpenClawContractError("Uncorrected OpenClaw request did not reproduce the 404", {
      capturedRequest: request,
    });
  }
  return {
    configuration,
    request,
    runtime: {
      provider: "openrouter",
      model: OPENROUTER_MODEL,
      authMode: "auth-profile",
      authProfile,
    },
    result: {
      exitCode: result.exitCode,
      signal: result.signal,
      completed: false,
      stoppedAfterAuthoritativeRequestCapture: true,
      output: null,
    },
  };
}

function parseOpenClawDiagnosticProbe(result, { configuration, authProfile, expectedSuccess }) {
  if (result.timedOut) {
    throw new OpenClawContractError("OpenClaw endpoint diagnostic timed out");
  }
  const envelope = parseCommandJson(result);
  const meta = envelope.meta ?? {};
  const agentMeta = meta.agentMeta ?? {};
  const lastAttempt = meta.executionTrace?.attempts?.at(-1) ?? {};
  const request = parseOpenAiRequestLog(result);
  const expectedRequest = new URL(
    "chat/completions",
    `${configuration.baseUrl.replace(/\/$/, "")}/`,
  );
  const provider = envelope.provider ?? agentMeta.provider ?? lastAttempt.provider ?? null;
  const model = envelope.model ?? agentMeta.model ?? lastAttempt.model ?? null;
  const stopReason = envelope.status ?? meta.stopReason ?? meta.completion?.finishReason ?? null;
  const output = envelope.final ?? envelope.payloads?.[0]?.text ?? null;
  const succeeded =
    result.exitCode === 0 &&
    envelope.ok !== false &&
    !meta.error &&
    meta.aborted !== true &&
    meta.livenessState !== "blocked" &&
    (stopReason === "ok" || stopReason === "stop") &&
    request.httpStatus === 200;

  if (
    request.method !== "POST" ||
    request.origin !== expectedRequest.origin ||
    request.path !== `${expectedRequest.pathname}${expectedRequest.search}`
  ) {
    throw new OpenClawContractError("OpenClaw request path did not match its configured base URL", {
      configuredBaseUrl: configuration.baseUrl,
      capturedRequest: request,
    });
  }
  if (provider !== "openrouter" || model !== OPENROUTER_MODEL) {
    throw new OpenClawContractError("OpenClaw endpoint diagnostic used the wrong provider or model", {
      provider,
      model,
    });
  }
  if (expectedSuccess && (!succeeded || String(output).trim() !== "OK")) {
    throw new OpenClawContractError("Corrected OpenClaw endpoint did not complete real inference");
  }
  if (!expectedSuccess && (succeeded || request.httpStatus !== 404)) {
    throw new OpenClawContractError("Uncorrected OpenClaw endpoint did not reproduce the 404");
  }

  return {
    configuration,
    request,
    runtime: {
      provider,
      model,
      authMode: meta.requestShaping?.authMode ?? null,
      authProfile,
    },
    result: {
      exitCode: result.exitCode,
      completed: succeeded,
      stopReason,
      livenessState: meta.livenessState ?? null,
      errorKind: meta.error?.kind ?? null,
      output: expectedSuccess ? String(output).trim() : null,
    },
  };
}

export function parseOpenRouterAuthProof(status) {
  if (status.resolvedDefault !== OPENCLAW_MODEL) {
    throw new OpenClawContractError("OpenClaw resolved the wrong diagnostic model");
  }
  const openrouter = status.auth?.providers?.find((provider) => provider.provider === "openrouter");
  const match = openrouter?.profiles?.labels
    ?.map((label) => label.match(/^([^=]+)=ref\(env:OPENROUTER_API_KEY\)$/))
    .find(Boolean);
  if (!match) {
    throw new OpenClawContractError(
      "OpenClaw did not resolve its OpenRouter auth profile from OPENROUTER_API_KEY",
    );
  }
  return {
    provider: "openrouter",
    profileId: match[1],
    credentialSource: "OPENROUTER_API_KEY",
    credentialStorage: "env SecretRef",
  };
}

async function readOpenRouterExperimentConfiguration(stateDir) {
  const command = await requireSuccessfulJsonCommand(["config", "get", "models", "--json"], {
    stateDir,
    timeoutMs: 30_000,
  });
  const models = command.json;
  const provider = models.providers?.openrouter;
  if (
    models.mode !== "replace" ||
    provider?.api !== "openai-completions" ||
    typeof provider.baseUrl !== "string" ||
    !Array.isArray(provider.models)
  ) {
    throw new OpenClawContractError("OpenClaw endpoint experiment configuration is incomplete");
  }
  return {
    modelsMode: models.mode,
    provider: "openrouter",
    api: provider.api,
    baseUrl: provider.baseUrl,
    models: provider.models.map(
      ({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({
        id,
        name,
        reasoning,
        input,
        cost,
        contextWindow,
        maxTokens,
      }),
    ),
  };
}

async function runDirectOpenRouterDiagnostic() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let response;
  try {
    response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [{ role: "user", content: DIAGNOSTIC_PROMPT }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.json().catch(() => null);
  const content = body?.choices?.[0]?.message?.content?.trim();
  const finishReason = body?.choices?.[0]?.finish_reason ?? null;
  const usage = {
    promptTokens: Number(body?.usage?.prompt_tokens ?? 0),
    completionTokens: Number(body?.usage?.completion_tokens ?? 0),
    totalTokens: Number(body?.usage?.total_tokens ?? 0),
  };
  if (
    response.status !== 200 ||
    !contentType.includes("application/json") ||
    content !== "OK" ||
    finishReason !== "stop" ||
    usage.totalTokens <= 0
  ) {
    throw new OpenClawContractError("Direct OpenRouter diagnostic did not complete real inference", {
      httpStatus: response.status,
      contentType,
      finishReason,
      totalTokens: usage.totalTokens,
    });
  }
  return {
    method: "POST",
    origin: new URL(OPENROUTER_BASE_URL).origin,
    path: `${new URL(OPENROUTER_BASE_URL).pathname}/chat/completions`,
    requestedModel: OPENROUTER_MODEL,
    responseModel: body.model ?? null,
    httpStatus: response.status,
    contentType,
    output: content,
    finishReason,
    usage,
  };
}

export function evaluateOpenRouterDiagnostic(diagnostic) {
  const beforeConfiguration = { ...diagnostic.openClawBeforeCorrection.configuration };
  const afterConfiguration = { ...diagnostic.openClawAfterCorrection.configuration };
  delete beforeConfiguration.baseUrl;
  delete afterConfiguration.baseUrl;
  const checks = {
    directOfficialEndpointRealInference:
      diagnostic.directProviderRequest.origin === "https://openrouter.ai" &&
      diagnostic.directProviderRequest.path === "/api/v1/chat/completions" &&
      diagnostic.directProviderRequest.requestedModel === OPENROUTER_MODEL &&
      diagnostic.directProviderRequest.responseModel === OPENROUTER_MODEL &&
      diagnostic.directProviderRequest.httpStatus === 200 &&
      diagnostic.directProviderRequest.output === "OK" &&
      diagnostic.directProviderRequest.usage.totalTokens > 0,
    oneChangedCondition:
      JSON.stringify(beforeConfiguration) === JSON.stringify(afterConfiguration) &&
      diagnostic.openClawBeforeCorrection.configuration.baseUrl ===
        diagnostic.observedGeneratedBaseUrl &&
      diagnostic.openClawAfterCorrection.configuration.baseUrl === OPENROUTER_BASE_URL &&
      typeof diagnostic.controlledComparison.startingStateSha256 === "string" &&
      diagnostic.controlledComparison.startingStateSha256.length === 64,
    authoritativeOpenClawRequestPaths:
      diagnostic.openClawBeforeCorrection.request.path === "/v1/chat/completions" &&
      diagnostic.openClawBeforeCorrection.request.httpStatus === 404 &&
      diagnostic.openClawAfterCorrection.request.path === "/api/v1/chat/completions" &&
      diagnostic.openClawAfterCorrection.request.httpStatus === 200,
    sameOpenClawModelAndAuth:
      diagnostic.openClawBeforeCorrection.runtime.provider === "openrouter" &&
      diagnostic.openClawAfterCorrection.runtime.provider === "openrouter" &&
      diagnostic.openClawBeforeCorrection.runtime.model === OPENROUTER_MODEL &&
      diagnostic.openClawAfterCorrection.runtime.model === OPENROUTER_MODEL &&
      diagnostic.openClawBeforeCorrection.runtime.authMode === "auth-profile" &&
      diagnostic.openClawAfterCorrection.runtime.authMode === "auth-profile" &&
      JSON.stringify(diagnostic.openClawBeforeCorrection.runtime.authProfile) ===
        JSON.stringify(diagnostic.openClawAfterCorrection.runtime.authProfile) &&
      diagnostic.openClawAfterCorrection.runtime.authProfile.credentialSource ===
        "OPENROUTER_API_KEY",
    correctedOpenClawRealInference:
      diagnostic.openClawAfterCorrection.result.completed === true &&
      diagnostic.openClawAfterCorrection.result.output === "OK",
    credentialRedaction:
      diagnostic.credentialSource === "OPENROUTER_API_KEY" &&
      diagnostic.credentialValueRetained === false,
  };
  return checks;
}

async function runOpenRouterDiagnostic({ stateDir, generatedOpenRouterBaseUrl, openclawVersion }) {
  const beforeAuthStatus = await requireSuccessfulJsonCommand(
    ["models", "status", "--agent", "main", "--json"],
    { stateDir, timeoutMs: 30_000 },
  );
  const beforeAuthProfile = parseOpenRouterAuthProof(beforeAuthStatus.json);
  const beforeConfiguration = await readOpenRouterExperimentConfiguration(stateDir);
  const beforeStateDir = path.join(path.dirname(stateDir), "diagnostic-before-state");
  await cp(stateDir, beforeStateDir, { recursive: true, errorOnExist: true, force: false });
  const startingStateSha256 = await hashDirectory(stateDir);
  if ((await hashDirectory(beforeStateDir)) !== startingStateSha256) {
    throw new OpenClawContractError("OpenClaw diagnostic state snapshot was not identical");
  }
  const beforeResult = await runOpenClaw(
    [
      "agent",
      "--local",
      "--agent",
      "main",
      "--session-id",
      DIAGNOSTIC_SESSION_ID,
      "--message",
      DIAGNOSTIC_PROMPT,
      "--timeout",
      "60",
      "--json",
    ],
    {
      stateDir: beforeStateDir,
      timeoutMs: FAILED_DIAGNOSTIC_CAPTURE_TIMEOUT_MS,
      env: { OPENAI_LOG: "info" },
      stopWhen: (partialResult) => {
        try {
          return parseOpenAiRequestLog(partialResult).httpStatus === 404;
        } catch {
          return false;
        }
      },
    },
  );
  const openClawBeforeCorrection = parseFailedOpenClawDiagnosticProbe(beforeResult, {
    configuration: beforeConfiguration,
    authProfile: beforeAuthProfile,
  });

  await setConfig(stateDir, "models.providers.openrouter.baseUrl", OPENROUTER_BASE_URL);
  const afterAuthStatus = await requireSuccessfulJsonCommand(
    ["models", "status", "--agent", "main", "--json"],
    { stateDir, timeoutMs: 30_000 },
  );
  const afterAuthProfile = parseOpenRouterAuthProof(afterAuthStatus.json);
  const afterConfiguration = await readOpenRouterExperimentConfiguration(stateDir);
  const afterResult = await runOpenClaw(
    [
      "agent",
      "--local",
      "--agent",
      "main",
      "--session-id",
      DIAGNOSTIC_SESSION_ID,
      "--message",
      DIAGNOSTIC_PROMPT,
      "--timeout",
      "60",
      "--json",
    ],
    { stateDir, timeoutMs: 90_000, env: { OPENAI_LOG: "info" } },
  );
  const openClawAfterCorrection = parseOpenClawDiagnosticProbe(afterResult, {
    configuration: afterConfiguration,
    authProfile: afterAuthProfile,
    expectedSuccess: true,
  });
  const directProviderRequest = await runDirectOpenRouterDiagnostic();
  const diagnostic = {
    schemaVersion: 2,
    credentialSource: "OPENROUTER_API_KEY",
    credentialValueRetained: false,
    openclawVersion,
    observedGeneratedBaseUrl: generatedOpenRouterBaseUrl,
    officialBaseUrl: OPENROUTER_BASE_URL,
    controlledComparison: {
      changedCondition: "models.providers.openrouter.baseUrl",
      keptConstant: [
        "models.mode=replace",
        `model=${OPENROUTER_MODEL}`,
        `authProfile=${beforeAuthProfile.profileId}`,
        `prompt=${DIAGNOSTIC_PROMPT}`,
        `sessionId=${DIAGNOSTIC_SESSION_ID}`,
      ],
      requestCapture: "OpenAI SDK info log emitted inside the OpenClaw process",
      failedRequestCaptureTimeoutMs: FAILED_DIAGNOSTIC_CAPTURE_TIMEOUT_MS,
      stateIsolation:
        "Both conditions started from the same state snapshot; the failing request ran in a clone and only the corrected state's baseUrl changed.",
      startingStateSha256,
    },
    directProviderRequest,
    openClawBeforeCorrection,
    openClawAfterCorrection,
    conclusion:
      "Changing only the OpenRouter base URL moved OpenClaw from /v1/chat/completions 404 to successful real inference at /api/v1/chat/completions.",
  };
  const acceptanceCriteria = evaluateOpenRouterDiagnostic(diagnostic);
  const failed = Object.entries(acceptanceCriteria).filter(([, passed]) => !passed);
  if (failed.length > 0) {
    throw new OpenClawContractError(
      `OpenRouter diagnostic failed: ${failed.map(([name]) => name).join(", ")}`,
    );
  }
  const serialized = JSON.stringify(diagnostic);
  if (serialized.includes(process.env.OPENROUTER_API_KEY)) {
    throw new OpenClawContractError("OpenRouter diagnostic retained the credential value");
  }
  return { ...diagnostic, acceptanceCriteria };
}

export async function writeChecksums(evidenceDir) {
  const files = (await listFiles(evidenceDir)).filter((file) => file !== "sha256sums.txt");
  const lines = [];
  for (const file of files) {
    const contents = await readFile(path.join(evidenceDir, file));
    lines.push(`${createHash("sha256").update(contents).digest("hex")}  ${file}`);
  }
  await writeFile(path.join(evidenceDir, "sha256sums.txt"), `${lines.join("\n")}\n`);
}

export async function runSpike({ runtimeDir, evidenceDir }) {
  const startedAt = new Date().toISOString();
  await mkdir(runtimeDir, { recursive: false });
  await mkdir(path.dirname(evidenceDir), { recursive: true });
  await mkdir(evidenceDir, { recursive: false });
  const { stateDir, onboard, generatedOpenRouterBaseUrl } = await initializeOpenClaw(runtimeDir);
  const versionResult = await runOpenClaw(["--version"], { stateDir, timeoutMs: 10_000 });
  const openclawVersion = versionResult.stdout.trim();
  const diagnostic = await runOpenRouterDiagnostic({
    stateDir,
    generatedOpenRouterBaseUrl,
    openclawVersion,
  });
  await writeFile(
    path.join(evidenceDir, "diagnostic-openrouter.json"),
    `${JSON.stringify(diagnostic, null, 2)}\n`,
  );

  const creationRecords = [];
  const workspaceFiles = {};
  for (const agent of AGENT_DEFINITIONS) {
    const workspaceDir = path.join(runtimeDir, "workspaces", agent.id);
    workspaceFiles[agent.id] = await writeAgentWorkspace(workspaceDir, agent);
    const created = await requireSuccessfulJsonCommand(
      [
        "agents",
        "add",
        agent.id,
        "--workspace",
        workspaceDir,
        "--model",
        OPENCLAW_MODEL,
        "--non-interactive",
        "--json",
      ],
      { stateDir, timeoutMs: 30_000 },
    );
    await requireSuccessfulCommand(
      ["agents", "set-identity", "--workspace", workspaceDir, "--from-identity", "--json"],
      { stateDir, timeoutMs: 30_000 },
    );
    creationRecords.push(created.json);
  }

  const listed = await requireSuccessfulJsonCommand(["agents", "list", "--json"], {
    stateDir,
    timeoutMs: 30_000,
  });

  const turns = [];
  await mkdir(path.join(evidenceDir, "turns"), { recursive: true });
  await mkdir(path.join(evidenceDir, "workspaces"), { recursive: true });
  for (const agent of AGENT_DEFINITIONS) {
    const prompt = composePrompt(agent);
    const commandResult = await runOpenClaw(
      [
        "agent",
        "--local",
        "--agent",
        agent.id,
        "--message",
        prompt,
        "--timeout",
        "180",
        "--json",
      ],
      { stateDir, timeoutMs: 210_000 },
    );
    const parsed = parseTurnResult(commandResult);
    const injectedFiles = parsed.envelope.meta?.systemPromptReport?.injectedWorkspaceFiles ?? [];
    const contractValidation = validateAgentProof({
      agent,
      output: parsed.output,
      injectedWorkspaceFiles: injectedFiles,
    });

    const normalized = {
      agentId: agent.id,
      output: parsed.output,
      usage: parsed.usage,
      completion: parsed.completion,
      runtime: parsed.runtime,
      contractValidation,
      injectedWorkspaceFiles: injectedFiles
        .filter((file) => ["IDENTITY.md", "MEMORY.md", "SOUL.md"].includes(file.name))
        .map(({ name, missing, rawChars, injectedChars, truncated }) => ({
          name,
          missing,
          rawChars,
          injectedChars,
          truncated,
        })),
    };
    turns.push(normalized);
    await writeFile(path.join(evidenceDir, "turns", `${agent.id}-prompt.txt`), `${prompt}\n`);
    await writeFile(
      path.join(evidenceDir, "turns", `${agent.id}-openclaw-envelope.json`),
      `${JSON.stringify(parsed.envelope, null, 2)}\n`,
    );
    await writeFile(
      path.join(evidenceDir, "turns", `${agent.id}-normalized.json`),
      `${JSON.stringify(normalized, null, 2)}\n`,
    );
    const workspaceEvidenceDir = path.join(evidenceDir, "workspaces", agent.id);
    await mkdir(workspaceEvidenceDir, { recursive: true });
    for (const fileName of ["IDENTITY.md", "SOUL.md", "MEMORY.md"]) {
      await writeFile(
        path.join(workspaceEvidenceDir, fileName),
        workspaceFiles[agent.id][fileName],
      );
    }
  }

  const listedAgents = Array.isArray(listed.json) ? listed.json : listed.json.agents;
  const proofAgents = listedAgents.filter((agent) =>
    AGENT_DEFINITIONS.some((definition) => definition.id === agent.id),
  );
  await writeFile(
    path.join(evidenceDir, "agents.json"),
    `${JSON.stringify(proofAgents, null, 2)}\n`,
  );

  const evidence = {
    schemaVersion: 1,
    ticket: "FACT-1",
    startedAt,
    completedAt: new Date().toISOString(),
    environment: {
      openclawVersion,
      nodeVersion: process.version,
      stdinIsTTY: Boolean(process.stdin.isTTY),
      model: OPENCLAW_MODEL,
      credentialSource: "OPENROUTER_API_KEY",
      credentialStorage: "OpenClaw env SecretRef; value not retained",
    },
    controlSurface: {
      create: "openclaw agents add --non-interactive --json",
      wake: "openclaw agent --local --json",
      completion:
        "process termination plus structured envelope validation; exit code alone is insufficient on OpenClaw 2026.4.15",
      output: "OpenClaw JSON envelope payload parsed as strict OrbitFlow output JSON",
    },
    acceptanceCriteria: {
      twoAgentsCreatedFromCode: {
        passed: proofAgents.length === 2,
        evidence: "agents.json and workspaces/*",
      },
      eachAgentWakesAndCompletes: {
        passed: turns.length === 2 && turns.every((turn) => turn.completion.exitCode === 0),
        evidence: "turns/*-normalized.json",
      },
      structuredOutputNotLogScraping: {
        passed: turns.every((turn) => turn.output && Array.isArray(turn.output.events)),
        evidence: "turns/*-openclaw-envelope.json and turns/*-normalized.json",
      },
      perTurnTokenUsage: {
        passed: turns.every((turn) => turn.usage.total > 0),
        evidence: "turns/*-normalized.json",
      },
      distinctPersonasAndPersistentMemory: {
        passed:
          turns.length === AGENT_DEFINITIONS.length &&
          new Set(turns.map((turn) => turn.output.artifact.persona)).size ===
            AGENT_DEFINITIONS.length &&
          turns.every((turn) => Object.values(turn.contractValidation).every(Boolean)),
        evidence: "workspaces/* and turns/*-normalized.json",
      },
      directOpenRouterAndOpenClawEndpointDiagnostic: {
        passed: Object.values(diagnostic.acceptanceCriteria).every(Boolean),
        evidence: "diagnostic-openrouter.json",
      },
      headlessComposeDecision: {
        passed: true,
        conclusion:
          "No host-side sidecar is required. Use a dedicated OpenClaw gateway container in the future compose stack; the official image supports this. This run proved non-TTY embedded execution but did not launch Docker.",
        evidence: "https://docs.openclaw.ai/install/docker",
      },
    },
    findings: {
      decision: "OpenClaw remains viable as OrbitFlow's execution plane.",
      verifiedWorkaround:
        "Pin models.providers.openrouter.baseUrl to https://openrouter.ai/api/v1 with models.mode=replace. OpenClaw 2026.4.15 generated https://openrouter.ai/v1 and otherwise sent requests to a 404 path.",
      installedSurface:
        "OpenClaw 2026.4.15 lacks the current documented agent exec command, so the spike uses agent --local --json.",
      scalingBoundary:
        "Embedded --local runs exclusively lock one state directory. The production RuntimeAdapter should use the containerized Gateway protocol for concurrent orchestration.",
      adapterSeed: {
        createAgent: "createAgent({ id, workspace, model })",
        wakeAgent: "wakeAgent({ id, composedPrompt, timeoutMs })",
        turnResult:
          "{ output: { artifact, handoff_brief, events }, usage, completion, runtime }",
        completionRule:
          "Reject timeout, nonzero exit, meta.error, blocked liveness, malformed output, or missing/zero usage.",
      },
    },
    agents: creationRecords.map(({ agentId, name, model }) => ({ agentId, name, model })),
    turns,
    onboarding: {
      ok: onboard.ok,
      mode: onboard.mode,
      authChoice: onboard.authChoice,
      installDaemon: onboard.installDaemon,
    },
  };

  const failed = Object.entries(evidence.acceptanceCriteria).filter(([, value]) => !value.passed);
  if (failed.length > 0) {
    throw new OpenClawContractError(
      `Acceptance criteria failed: ${failed.map(([name]) => name).join(", ")}`,
    );
  }
  await writeFile(path.join(evidenceDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  await writeChecksums(evidenceDir);
  return evidence;
}
