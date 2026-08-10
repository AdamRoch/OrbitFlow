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
  return files;
}

function redactEvidence(value) {
  const serialized = JSON.stringify(value);
  if (process.env.OPENROUTER_API_KEY && serialized.includes(process.env.OPENROUTER_API_KEY)) {
    throw new OpenClawContractError("Platform tool evidence retained the credential value");
  }
  return value;
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
    const workspaceFiles = await writePlatformToolWorkspace(workspaceDir, toolCliPath);

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
    const invocation = validatePlatformToolInvocation(await parsePlatformToolAudit(await readFile(auditFile, "utf8")));
    const normalizedTurn = {
      agentId: PLATFORM_TOOL_AGENT_ID,
      output: turn.output,
      usage: turn.usage,
      completion: turn.completion,
      runtime: turn.runtime,
    };
    const evidence = redactEvidence({
      schemaVersion: 1,
      ticket: "FACT-2",
      environment: {
        openclawVersion: (await runOpenClaw(["--version"], { stateDir, timeoutMs: 10_000 })).stdout.trim(),
        nodeVersion: process.version,
        model: OPENCLAW_MODEL,
        credentialSource: "OPENROUTER_API_KEY",
        credentialValueRetained: false,
      },
      registration: {
        agent: PLATFORM_TOOL_AGENT_ID,
        mechanism: "workspace TOOLS.md plus OpenClaw built-in exec tool",
        allow: ["exec"],
        exec: {
          host: "gateway",
          security: "full",
          ask: "off",
          platformCli: "node ./orbit-tool.mjs echo <payload>",
        },
      },
      acceptanceCriteria: {
        agentCallsCustomCliWithoutHumanHelp: {
          passed: Object.values(invocation).every(Boolean),
          evidence: "platform-tool-invocations.jsonl",
        },
        platformCapturesCallAndArguments: {
          passed: Object.values(invocation).every(Boolean),
          evidence: "platform-tool-invocations.jsonl",
        },
        structuredCompletionAndUsage: {
          passed: normalizedTurn.completion.exitCode === 0 && normalizedTurn.usage.total > 0,
          evidence: "turn-normalized.json",
        },
        credentialRedaction: {
          passed: true,
          evidence: "evidence.json",
        },
      },
      turn: normalizedTurn,
      invocationValidation: invocation,
      workspace: Object.fromEntries(
        ["AGENTS.md", "SOUL.md", "IDENTITY.md", "MEMORY.md", "TOOLS.md"].map((name) => [name, workspaceFiles[name]]),
      ),
      findings: {
        registration:
          "TOOLS.md documents the platform CLI, while tools.allow=[exec] exposes only OpenClaw's supported exec tool.",
        path:
          "Installed OpenClaw 2026.4.15 embedded mode did not preserve either tools.exec.pathPrepend or the launcher's PATH override for the exec child. This proof therefore supplies the CLI in the isolated workspace and invokes it through the available Node runtime.",
        sandbox:
          "This embedded --local proof uses host=gateway with security=full inside a fresh disposable runtime. It is not a production sandbox claim. A future containerized gateway must mount the platform CLI into the sandbox image, configure its in-container PATH, and replace this broad execution policy with a tool-specific boundary.",
        futureTools:
          "create_ticket and post_message should use the same narrow executable registration, explicit argument schema, and structured platform-side audit capture rather than terminal text.",
      },
    });
    const failed = Object.entries(evidence.acceptanceCriteria).filter(([, criterion]) => !criterion.passed);
    if (failed.length > 0) {
      throw new OpenClawContractError(`FACT-2 acceptance failed: ${failed.map(([name]) => name).join(", ")}`);
    }
    await writeFile(path.join(absoluteEvidenceDir, "turn-normalized.json"), `${JSON.stringify(normalizedTurn, null, 2)}\n`);
    await writeFile(path.join(absoluteEvidenceDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    await writeChecksums(absoluteEvidenceDir);
    return evidence;
  } finally {
    await rm(absoluteRuntimeDir, { recursive: true, force: true, maxRetries: 3 });
  }
}
