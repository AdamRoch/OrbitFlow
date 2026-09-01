#!/usr/bin/env node

import http from "node:http";
import {
  loadOpenClawToolContext,
} from "../src/lib/runtime/openclaw-tool-context.mjs";
import { validateOpenClawToolInput } from "../src/lib/runtime/openclaw-tool-input.mjs";

const PLATFORM_COMMANDS = new Set([
  "list_projects",
  "create_ticket",
  "update_ticket",
  "set_ticket_dependencies",
  "post_message",
  "list_tickets",
]);
const CODING_COMMANDS = new Set(["start_run_workspace", "delegate_coding_task"]);
const BROKER_SOCKET = process.env.ORBITFLOW_TOOL_BROKER_SOCKET ?? "/run/orbitflow-broker/tool.sock";
const BROKER_URL = process.env.ORBITFLOW_TOOL_BROKER_URL?.trim() || null;
const BROKER_TOKEN = process.env.ORBITFLOW_TOOL_BROKER_TOKEN?.trim() || null;
const AGENT_WORKSPACE_ROOT = process.env.ORBITFLOW_AGENT_WORKSPACE_ROOT
  ?? "/var/lib/orbitflow/runtime/workspaces";

if (BROKER_URL !== null && BROKER_TOKEN === null) {
  throw new Error("ORBITFLOW_TOOL_BROKER_TOKEN is required with ORBITFLOW_TOOL_BROKER_URL");
}

try {
  const [command, ...inputArguments] = process.argv.slice(2);
  if (
    typeof command !== "string" ||
    (!PLATFORM_COMMANDS.has(command) && !CODING_COMMANDS.has(command)) ||
    inputArguments.length === 0
  ) {
    throw new Error("usage: orbit-openclaw-tool <command> <json-input>");
  }
  const serializedInput = inputArguments.join(" ");
  if (Buffer.byteLength(serializedInput) > 32_768) {
    throw new Error("json-input exceeds 32768 bytes");
  }
  const supplied = parseInput(command, serializedInput);
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    throw new Error("json-input must be one JSON object");
  }
  validateOpenClawToolInput(command, supplied);

  const { context, workspace } = await loadOpenClawToolContext({
    agentWorkspaceRoot: AGENT_WORKSPACE_ROOT,
    workspace: process.cwd(),
  });
  const response = await brokerRequest({ command, input: supplied, context, workspace });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (response?.ok !== true) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: { code: "invalid_context", message: String(error?.message ?? error).slice(0, 256) },
  })}\n`);
  process.exitCode = 1;
}

function parseInput(command, serializedInput) {
  try {
    return JSON.parse(serializedInput);
  } catch (error) {
    if (command !== "delegate_coding_task") throw error;
    const shellStrippedTask = serializedInput.match(/^\{task:(.*)\}$/s)?.[1]?.trim();
    if (!shellStrippedTask) throw error;
    return { task: shellStrippedTask };
  }
}

function brokerRequest(payload) {
  if (BROKER_URL !== null) return remoteBrokerRequest(payload);
  return socketBrokerRequest(payload);
}

async function remoteBrokerRequest(payload) {
  const response = await fetch(`${BROKER_URL}/v1/tool`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${BROKER_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const contents = await response.text();
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error("tool broker returned malformed JSON");
  }
}

function socketBrokerRequest(payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: BROKER_SOCKET,
      path: "/v1/tool",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      let contents = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        contents += chunk;
        if (Buffer.byteLength(contents) > 12 * 1024 * 1024) {
          request.destroy(new Error("tool broker response is too large"));
        }
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(contents));
        } catch {
          reject(new Error("tool broker returned malformed JSON"));
        }
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}
