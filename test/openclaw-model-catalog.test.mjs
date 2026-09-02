import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  loadOpenClawModelCatalog,
  parseOpenClawModelCatalog,
  validateConfiguredAgentModels,
} from "../src/lib/runtime/openclaw-model-catalog.mjs";

const execFileAsync = promisify(execFile);
const CONFIG_URL = new URL("../docker/openclaw/openclaw.json", import.meta.url);

test("FACT-35 committed OpenClaw catalog has one registered primary contract", async () => {
  const catalog = await loadOpenClawModelCatalog(CONFIG_URL);
  assert.ok(catalog.availableModels.includes(catalog.primaryModel));

  const config = JSON.parse(await readFile(CONFIG_URL, "utf8"));
  config.agents.defaults.model.primary = "openrouter/unregistered/model";
  assert.throws(
    () => parseOpenClawModelCatalog(config),
    /primary model "openrouter\/unregistered\/model" is not registered/,
  );
});

test("FACT-35 agent validation names every unavailable database reference clearly", async () => {
  const catalog = await loadOpenClawModelCatalog(CONFIG_URL);
  await assert.rejects(
    validateConfiguredAgentModels(
      { query: async () => ({ rows: [{ name: "Factory Planner", model: "openrouter/missing/model" }] }) },
      catalog,
    ),
    /agent "Factory Planner" references unavailable model "openrouter\/missing\/model".*registered models:/,
  );
});

test("FACT-35 OpenClaw config application replaces stale runtime model state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbitflow-fact35-config-"));
  const currentPath = path.join(directory, "current.json");
  try {
    await writeFile(currentPath, JSON.stringify({
      models: { providers: { stale: {} } },
      agents: { list: [{ id: "kept-agent" }], defaults: { model: { primary: "stale/model" } } },
    }));
    await execFileAsync(process.execPath, [
      new URL("../docker/openclaw/apply-config.mjs", import.meta.url).pathname,
      currentPath,
      CONFIG_URL.pathname,
    ]);
    const applied = JSON.parse(await readFile(currentPath, "utf8"));
    const committed = JSON.parse(await readFile(CONFIG_URL, "utf8"));
    assert.deepEqual(applied.models, committed.models);
    assert.deepEqual(applied.agents.defaults, committed.agents.defaults);
    assert.deepEqual(applied.agents.list, [{ id: "kept-agent" }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
