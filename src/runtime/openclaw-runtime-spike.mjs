import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const OPENCLAW_MODEL = "openrouter/openai/gpt-4.1-mini";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

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
  const { cwd = process.cwd(), env = process.env, timeoutMs = 180_000 } = options;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimer;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
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
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    });
  });
}

export async function runOpenClaw(args, { stateDir, timeoutMs = 180_000 } = {}) {
  const result = await runProcess("openclaw", ["--no-color", ...args], {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    timeoutMs,
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

async function setConfig(stateDir, configPath, value) {
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

async function initializeOpenClaw(runtimeDir) {
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
  await setConfig(stateDir, "models.mode", "replace");
  await setConfig(stateDir, "models.providers.openrouter", {
    baseUrl: OPENROUTER_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: "openai/gpt-4.1-mini",
        name: "OpenAI GPT-4.1 Mini",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_047_576,
        maxTokens: 32_768,
      },
    ],
  });
  await setConfig(stateDir, "tools.profile", "minimal");
  return { stateDir, onboard: onboard.json };
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

async function writeChecksums(evidenceDir) {
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
  const { stateDir, onboard } = await initializeOpenClaw(runtimeDir);
  const versionResult = await runOpenClaw(["--version"], { stateDir, timeoutMs: 10_000 });
  const openclawVersion = versionResult.stdout.trim();

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
    const expectedPhrase = agent.memoryFact.replace(/^The durable (?:launch|safety) phrase is /, "").replace(/\.$/, "");
    if (!parsed.output.artifact.memory_fact.includes(expectedPhrase)) {
      throw new OpenClawContractError(`${agent.id} did not recall its persisted memory phrase`);
    }
    const injectedFiles = parsed.envelope.meta?.systemPromptReport?.injectedWorkspaceFiles ?? [];
    const memoryInjection = injectedFiles.find((file) => file.name === "MEMORY.md");
    const soulInjection = injectedFiles.find((file) => file.name === "SOUL.md");
    if (!memoryInjection || memoryInjection.missing || !soulInjection || soulInjection.missing) {
      throw new OpenClawContractError(`${agent.id} did not receive its persona and memory workspace files`);
    }

    const normalized = {
      agentId: agent.id,
      output: parsed.output,
      usage: parsed.usage,
      completion: parsed.completion,
      runtime: parsed.runtime,
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
          new Set(turns.map((turn) => turn.output.artifact.persona)).size === 2 &&
          turns.every((turn) =>
            turn.injectedWorkspaceFiles.some(
              (file) => file.name === "MEMORY.md" && !file.missing && !file.truncated,
            ),
          ),
        evidence: "workspaces/* and turns/*-normalized.json",
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
