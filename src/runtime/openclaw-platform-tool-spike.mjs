import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  OPENCLAW_MODEL,
  OPENROUTER_BASE_URL,
  OpenClawContractError,
  initializeOpenClaw,
  normalizeUsage,
  parseCommandJson,
  runOpenClaw,
  setConfig,
  writeChecksums,
} from "./openclaw-runtime-spike.mjs";

export const PLATFORM_TOOL_AGENT_ID = "fact-platform-tool";
export const PLATFORM_TOOL_PAYLOAD = "fact-2-platform-tool-payload";

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OpenClawContractError(`Platform tool proof field ${field} must be a non-empty string`);
  }
  return value;
}

export function parsePlatformToolAudit(contents) {
  const entries = String(contents)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new OpenClawContractError("Platform tool audit contains invalid JSON", {
          cause: error.message,
        });
      }
    });
  if (entries.length === 0) throw new OpenClawContractError("Platform tool audit is empty");
  return entries;
}

export function validatePlatformToolInvocation(entries, { payload = PLATFORM_TOOL_PAYLOAD } = {}) {
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new OpenClawContractError("Platform tool proof requires exactly one captured invocation", {
      invocationCount: Array.isArray(entries) ? entries.length : null,
    });
  }
  const [entry] = entries;
  const validation = {
    schemaVersion: entry.schemaVersion === 1,
    source: entry.source === "orbit-tool",
    command: entry.command === "orbit-tool",
    subcommand: entry.subcommand === "echo",
    payload: entry.payload === payload,
    exactArguments:
      Array.isArray(entry.args) && entry.args.length === 2 && entry.args[0] === "echo" && entry.args[1] === payload,
  };
  const failed = Object.entries(validation).filter(([, passed]) => !passed);
  if (failed.length > 0) {
    throw new OpenClawContractError(
      `Platform tool invocation validation failed: ${failed.map(([name]) => name).join(", ")}`,
    );
  }
  return validation;
}

export function validatePlatformToolWorkspaceInjection(injectedWorkspaceFiles) {
  const toolsFile = Array.isArray(injectedWorkspaceFiles)
    ? injectedWorkspaceFiles.find((candidate) => candidate.name === "TOOLS.md")
    : null;
  const validation = {
    toolsMdInjectedCompletely:
      toolsFile?.missing === false &&
      toolsFile.truncated === false &&
      Number.isInteger(toolsFile.rawChars) &&
      toolsFile.rawChars > 0 &&
      toolsFile.injectedChars === toolsFile.rawChars,
  };
  if (!validation.toolsMdInjectedCompletely) {
    throw new OpenClawContractError("Platform tool proof requires complete TOOLS.md workspace injection");
  }
  return validation;
}

export function parsePlatformToolAgentOutput(text, { payload = PLATFORM_TOOL_PAYLOAD } = {}) {
  const credential = process.env.OPENROUTER_API_KEY;
  const safeText = credential ? String(text).replaceAll(credential, "[redacted]") : String(text);
  let output;
  try {
    output = JSON.parse(safeText.trim());
  } catch (error) {
    throw new OpenClawContractError("Platform tool agent final output is not strict JSON", {
      cause: error.message,
    });
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new OpenClawContractError("Platform tool agent final output must be an object");
  }
  if (output.called !== "orbit-tool" || output.payload !== payload) {
    throw new OpenClawContractError("Platform tool agent final output did not acknowledge the required call");
  }
  requireString(output.result, "result");
  return output;
}

export function parsePlatformToolTurn(result, options = {}) {
  if (result.timedOut) {
    throw new OpenClawContractError("Platform tool OpenClaw turn timed out", { signal: result.signal });
  }
  const envelope = parseCommandJson(result);
  if (Object.hasOwn(envelope, "ok") && Object.hasOwn(envelope, "status")) {
    if (result.exitCode !== 0 || envelope.ok !== true || envelope.status !== "ok") {
      throw new OpenClawContractError("Platform tool stable turn envelope is not complete", {
        exitCode: result.exitCode,
        status: envelope.status,
      });
    }
    const output = parsePlatformToolAgentOutput(envelope.final ?? envelope.payloads?.[0]?.text, options);
    return {
      envelope,
      output,
      usage: normalizeUsage(envelope.usage),
      completion: { status: envelope.status, exitCode: result.exitCode },
      runtime: {
        sessionId: envelope.sessionId ?? null,
        provider: envelope.provider ?? null,
        model: envelope.model ?? null,
      },
    };
  }

  const meta = envelope.meta;
  const stopReason = meta?.stopReason ?? meta?.completion?.finishReason ?? null;
  if (
    result.exitCode !== 0 ||
    !meta ||
    meta.error ||
    meta.aborted === true ||
    meta.livenessState === "blocked" ||
    stopReason !== "stop"
  ) {
    throw new OpenClawContractError("Platform tool legacy turn did not complete successfully", {
      exitCode: result.exitCode,
      livenessState: meta?.livenessState ?? null,
      stopReason,
      error: meta?.error?.kind ?? null,
    });
  }
  const output = parsePlatformToolAgentOutput(envelope.payloads?.[0]?.text, options);
  const agentMeta = meta.agentMeta ?? {};
  return {
    envelope,
    output,
    usage: normalizeUsage(agentMeta.usage ?? agentMeta.lastCallUsage),
    completion: { status: stopReason, exitCode: result.exitCode },
    runtime: {
      sessionId: agentMeta.sessionId ?? null,
      provider: agentMeta.provider ?? null,
      model: agentMeta.model ?? null,
    },
  };
}

export function composePlatformToolPrompt({ payload = PLATFORM_TOOL_PAYLOAD } = {}) {
  return [
    "# Required action",
    `Call the platform CLI exactly once: node ./orbit-tool.mjs echo ${payload}`,
    "Use the exec tool. Do not simulate the call, do not ask for approval, and do not use any other command.",
    "",
    "# Output contract",
    'After the command succeeds, return only {"called":"orbit-tool","payload":"' + payload + '","result":"string"}.',
  ].join("\n");
}

async function writePlatformToolWorkspace(workspaceDir, toolCliPath) {
  const toolCli = await readFile(toolCliPath, "utf8");
  const files = {
    "AGENTS.md": "Follow TOOLS.md. Complete the requested command before returning the output contract.\n",
    "SOUL.md": "You are a bounded platform-tool proof agent. Execute only the requested tool call.\n",
    "IDENTITY.md": "# Platform Tool Proof Agent\n\n- Name: Platform Tool Proof Agent\n",
    "MEMORY.md": "# Durable memory\n\nThis is an isolated FACT-2 proof.\n",
    "orbit-tool.mjs": toolCli,
    "TOOLS.md": [
      "# Platform CLI",
      "",
      "Use `node ./orbit-tool.mjs echo <payload>` through OpenClaw's exec tool when the user requires a platform CLI call.",
      "This proof permits exactly one command: `node ./orbit-tool.mjs echo fact-2-platform-tool-payload`.",
    ].join("\n") + "\n",
  };
  await mkdir(workspaceDir, { recursive: true });
  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(path.join(workspaceDir, name), contents)),
  );
}

function redactEvidence(value) {
  const serialized = JSON.stringify(value);
  if (process.env.OPENROUTER_API_KEY && serialized.includes(process.env.OPENROUTER_API_KEY)) {
    throw new OpenClawContractError("Platform tool evidence retained the credential value");
  }
  return value;
}

export function buildPlatformToolEvidence({ normalizedTurn, invocationValidation, workspaceInjection }) {
  const invocationPassed = Object.values(invocationValidation).every(Boolean);
  const evidence = redactEvidence({
    schemaVersion: 1,
    ticket: "FACT-2",
    registration: {
      agent: PLATFORM_TOOL_AGENT_ID,
      workspaceInstruction: {
        name: "TOOLS.md",
        injectedCompletely: workspaceInjection.toolsMdInjectedCompletely,
      },
      allowedTools: ["exec"],
      exec: {
        host: "gateway",
        security: "full",
        ask: "off",
      },
      command: "node ./orbit-tool.mjs echo <payload>",
    },
    acceptanceCriteria: {
      toolsMdInjectedThroughOpenClaw: {
        passed: workspaceInjection.toolsMdInjectedCompletely,
        evidence: "boolean derived from OpenClaw structured injectedWorkspaceFiles metadata",
      },
      agentCallsCustomCliWithoutHumanHelp: {
        passed: workspaceInjection.toolsMdInjectedCompletely && invocationPassed,
        evidence: "platform-tool-invocations.jsonl",
      },
      platformCapturesCallAndArguments: {
        passed: invocationPassed,
        evidence: "platform-tool-invocations.jsonl",
      },
      structuredCompletionAndUsage: {
        passed: normalizedTurn.completion.exitCode === 0 && normalizedTurn.usage.total > 0,
        evidence: "turn-normalized.json",
      },
    },
  });
  const failed = Object.entries(evidence.acceptanceCriteria).filter(([, criterion]) => !criterion.passed);
  if (failed.length > 0) {
    throw new OpenClawContractError(`FACT-2 acceptance failed: ${failed.map(([name]) => name).join(", ")}`);
  }
  return evidence;
}

export async function runPlatformToolSpike({ runtimeDir, evidenceDir, toolBinDir }) {
  const absoluteRuntimeDir = path.resolve(runtimeDir);
  const absoluteEvidenceDir = path.resolve(evidenceDir);
  const absoluteToolBinDir = path.resolve(toolBinDir);
  const toolCliPath = path.join(absoluteToolBinDir, "orbit-tool.mjs");
  await mkdir(absoluteRuntimeDir, { recursive: false });
  await mkdir(path.dirname(absoluteEvidenceDir), { recursive: true });
  await mkdir(absoluteEvidenceDir, { recursive: false });

  try {
    const { stateDir } = await initializeOpenClaw(absoluteRuntimeDir);
    const workspaceDir = path.join(absoluteRuntimeDir, "workspace");
    const auditFile = path.join(absoluteEvidenceDir, "platform-tool-invocations.jsonl");
    await writePlatformToolWorkspace(workspaceDir, toolCliPath);

    // FACT-1 proved this installed OpenClaw release generates a broken OpenRouter URL.
    // Apply its verified override before this spike makes its one real agent call.
    await setConfig(stateDir, "models.providers.openrouter.baseUrl", OPENROUTER_BASE_URL);
    await setConfig(stateDir, "tools.allow", ["exec"]);
    await setConfig(stateDir, "tools.exec", {
      host: "gateway",
      security: "full",
      ask: "off",
    });

    const created = await runOpenClaw(
      [
        "agents",
        "add",
        PLATFORM_TOOL_AGENT_ID,
        "--workspace",
        workspaceDir,
        "--model",
        OPENCLAW_MODEL,
        "--non-interactive",
        "--json",
      ],
      { stateDir, timeoutMs: 30_000 },
    );
    if (created.exitCode !== 0 || created.timedOut) {
      throw new OpenClawContractError("OpenClaw did not create the platform tool agent", {
        exitCode: created.exitCode,
      });
    }

    const commandResult = await runOpenClaw(
      [
        "agent",
        "--local",
        "--agent",
        PLATFORM_TOOL_AGENT_ID,
        "--message",
        composePlatformToolPrompt(),
        "--timeout",
        "180",
        "--json",
      ],
      {
        stateDir,
        timeoutMs: 210_000,
        env: { ORBIT_TOOL_AUDIT_FILE: auditFile },
      },
    );
    const turn = parsePlatformToolTurn(commandResult);
    const workspaceInjection = validatePlatformToolWorkspaceInjection(
      turn.envelope.meta?.systemPromptReport?.injectedWorkspaceFiles,
    );
    const invocationValidation = validatePlatformToolInvocation(
      await parsePlatformToolAudit(await readFile(auditFile, "utf8")),
    );
    const normalizedTurn = {
      agentId: PLATFORM_TOOL_AGENT_ID,
      output: turn.output,
      usage: turn.usage,
      completion: turn.completion,
      runtime: turn.runtime,
    };
    const evidence = buildPlatformToolEvidence({
      normalizedTurn,
      invocationValidation,
      workspaceInjection,
    });
    await writeFile(
      path.join(absoluteEvidenceDir, "turn-normalized.json"),
      `${JSON.stringify(redactEvidence(normalizedTurn), null, 2)}\n`,
    );
    await writeFile(path.join(absoluteEvidenceDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    await writeChecksums(absoluteEvidenceDir);
    return evidence;
  } finally {
    await rm(absoluteRuntimeDir, { recursive: true, force: true, maxRetries: 3 });
  }
}
