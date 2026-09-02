import { readFile } from "node:fs/promises";

export const DEFAULT_OPENCLAW_CONFIG = new URL(
  "../../../docker/openclaw/openclaw.json",
  import.meta.url,
);

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`OpenClaw model configuration invalid: ${path} must be a non-empty string`);
  }
  return value.trim();
}

export function parseOpenClawModelCatalog(config) {
  const provider = config?.models?.providers?.openrouter;
  if (!provider || !Array.isArray(provider.models) || provider.models.length === 0) {
    throw new Error(
      "OpenClaw model configuration invalid: models.providers.openrouter.models must register at least one model",
    );
  }

  const providerModels = provider.models.map((entry, index) =>
    requiredString(entry?.id, `models.providers.openrouter.models[${index}].id`),
  );
  if (new Set(providerModels).size !== providerModels.length) {
    throw new Error("OpenClaw model configuration invalid: OpenRouter model ids must be unique");
  }

  const availableModels = providerModels.map((id) => `openrouter/${id}`);
  const availableSet = new Set(availableModels);
  const primaryModel = requiredString(
    config?.agents?.defaults?.model?.primary,
    "agents.defaults.model.primary",
  );
  if (!availableSet.has(primaryModel)) {
    throw new Error(
      `OpenClaw model configuration invalid: primary model "${primaryModel}" is not registered; available models: ${availableModels.join(", ")}`,
    );
  }

  const selectableModels = config?.agents?.defaults?.models;
  if (!selectableModels || typeof selectableModels !== "object" || Array.isArray(selectableModels)) {
    throw new Error(
      "OpenClaw model configuration invalid: agents.defaults.models must be an object",
    );
  }
  for (const model of Object.keys(selectableModels)) {
    if (!availableSet.has(model)) {
      throw new Error(
        `OpenClaw model configuration invalid: selectable model "${model}" is not registered; available models: ${availableModels.join(", ")}`,
      );
    }
  }
  if (!Object.hasOwn(selectableModels, primaryModel)) {
    throw new Error(
      `OpenClaw model configuration invalid: primary model "${primaryModel}" is missing from agents.defaults.models`,
    );
  }

  return Object.freeze({
    baseUrl: requiredString(provider.baseUrl, "models.providers.openrouter.baseUrl"),
    primaryModel,
    availableModels: Object.freeze(availableModels),
  });
}

export async function loadOpenClawModelCatalog(configPath = DEFAULT_OPENCLAW_CONFIG) {
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `OpenClaw model configuration invalid: could not read ${String(configPath)}: ${error.message}`,
      { cause: error },
    );
  }
  return parseOpenClawModelCatalog(config);
}

export async function validateConfiguredAgentModels(pool, catalog) {
  const result = await pool.query("SELECT name, model FROM agents ORDER BY id");
  const available = new Set(catalog.availableModels);
  const invalid = result.rows.filter((agent) => !available.has(agent.model));
  if (invalid.length > 0) {
    const references = invalid
      .map((agent) => `agent "${agent.name}" references unavailable model "${agent.model}"`)
      .join("; ");
    throw new Error(
      `OpenClaw model configuration invalid: ${references}; registered models: ${catalog.availableModels.join(", ")}`,
    );
  }
}
