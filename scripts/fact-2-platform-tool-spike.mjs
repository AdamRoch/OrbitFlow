#!/usr/bin/env node

import path from "node:path";

import { runPlatformToolSpike } from "../src/runtime/openclaw-platform-tool-spike.mjs";

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const runtimeDir = path.resolve(readArg("--runtime-dir", ".fact2-runtime"));
const evidenceDir = path.resolve(readArg("--evidence-dir", "evidence/fact-2"));
const toolBinDir = path.resolve(readArg("--tool-bin-dir", "bin"));

try {
  const evidence = await runPlatformToolSpike({ runtimeDir, evidenceDir, toolBinDir });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        ticket: evidence.ticket,
        evidenceDir,
        invocationValidation: evidence.invocationValidation,
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
