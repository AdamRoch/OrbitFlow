#!/usr/bin/env node

import { Pool } from "pg";
import { PLATFORM_TOOL_COMMANDS, PlatformToolError, dispatchPlatformTool } from "../src/lib/platform-tools/dispatch.ts";

const [command, serializedInput, ...extra] = process.argv.slice(2);

function failure(code, message) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message: String(message).slice(0, 256) } })}\n`);
  process.exitCode = 1;
}

if (!PLATFORM_TOOL_COMMANDS.includes(command) || extra.length !== 0 || typeof serializedInput !== "string") {
  failure("usage", "usage: orbit-agent-tools <create_ticket|update_ticket|post_message|list_tickets> <json-input>");
} else if (serializedInput.length > 32_768) {
  failure("too_large", "json-input exceeds 32768 characters");
} else if (!process.env.DATABASE_URL) {
  failure("configuration", "DATABASE_URL is required");
} else {
  let input;
  try {
    input = JSON.parse(serializedInput);
  } catch {
    failure("invalid_json", "json-input must be valid JSON");
  }
  if (input !== undefined) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: "orbitfactory-agent-tools" });
    try {
      const result = await dispatchPlatformTool(pool, command, input);
      process.stdout.write(`${JSON.stringify({ ok: true, command, result })}\n`);
    } catch (error) {
      if (error instanceof PlatformToolError) failure(error.code, error.message);
      else failure("internal", "internal server error");
    } finally {
      await pool.end();
    }
  }
}
