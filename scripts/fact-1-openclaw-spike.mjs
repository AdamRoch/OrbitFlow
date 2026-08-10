#!/usr/bin/env node

import path from "node:path";
import { runSpike } from "../src/runtime/openclaw-runtime-spike.mjs";

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const runtimeDir = path.resolve(readArg("--runtime-dir", ".fact1-runtime"));
const evidenceDir = path.resolve(readArg("--evidence-dir", "evidence/fact-1"));

try {
  const evidence = await runSpike({ runtimeDir, evidenceDir });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        ticket: evidence.ticket,
        decision: evidence.findings.decision,
        evidenceDir,
        turns: evidence.turns.map(({ agentId, usage, completion }) => ({
          agentId,
          usage,
          completion,
        })),
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: error.name,
        message: error.message,
        details: error.details ?? null,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
}
