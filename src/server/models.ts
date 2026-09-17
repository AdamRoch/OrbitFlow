import { Router } from "express";
import { z } from "zod";
import type { ModelCatalog, ModelOption } from "../shared/types.js";

const catalogUrl = "https://openrouter.ai/api/v1/models?sort=top-weekly&supported_parameters=tools";
const cacheMs = 30 * 60 * 1000;
const retryMs = 60 * 1000;
const catalogSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1).max(180),
    name: z.string().min(1).max(300),
    context_length: z.number().int().nonnegative(),
    architecture: z.object({
      input_modalities: z.array(z.string()),
      output_modalities: z.array(z.string()),
      tokenizer: z.string().optional(),
    }),
    supported_parameters: z.array(z.string()),
    pricing: z.object({ prompt: z.string().optional(), completion: z.string().optional() }),
    expiration_date: z.string().nullable().optional(),
  })),
});

function perMillion(value: string | undefined): number | null {
  if (value === undefined || !value.trim()) return null;
  const price = Number(value) * 1_000_000;
  return Number.isFinite(price) && price >= 0 ? price : null;
}

export function parseCatalog(body: unknown, now: number): ModelOption[] {
  const { data } = catalogSchema.parse(body);
  const seen = new Set<string>();
  return data.flatMap((model): ModelOption[] => {
    // OpenCode requires text and native tool calls, including StructuredOutput.
    // Avoid moving aliases and routers: choosing a suggestion should pin a model.
    if (
      !model.supported_parameters.includes("tools") ||
      !model.architecture.input_modalities.includes("text") ||
      !model.architecture.output_modalities.includes("text") ||
      model.architecture.tokenizer === "Router" ||
      model.id.endsWith(":batch") ||
      !/^[a-z0-9][a-z0-9._-]*\/[^\s]+$/i.test(model.id) ||
      (model.expiration_date && Date.parse(model.expiration_date) <= now) ||
      seen.has(model.id)
    ) return [];
    seen.add(model.id);
    return [{
      id: `openrouter/${model.id}`,
      name: model.name,
      contextLength: model.context_length,
      inputUsdPerMillion: perMillion(model.pricing.prompt),
      outputUsdPerMillion: perMillion(model.pricing.completion),
    }];
  });
}

export function createModelCatalog(fetcher: typeof fetch = fetch, now = Date.now) {
  let cached: ModelCatalog | undefined;
  let pending: Promise<ModelCatalog> | undefined;
  let retryAt = 0;
  return async function getCatalog(refresh = false): Promise<ModelCatalog> {
    if (pending) return pending;
    if (!refresh && cached && now() < retryAt) return cached;
    pending = (async () => {
      try {
        // This is a public metadata request. Never send a provider credential.
        const response = await fetcher(catalogUrl, { signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw Error("Catalog request failed");
        const models = parseCatalog(await response.json(), now());
        if (!models.length) throw Error("Empty catalog");
        cached = { models, fetchedAt: new Date(now()).toISOString(), stale: false };
        retryAt = now() + cacheMs;
        return cached;
      } catch {
        if (!cached) throw Error("OpenRouter suggestions are unavailable. Retry or enter a model ID.");
        cached = { ...cached, stale: true };
        retryAt = now() + retryMs;
        return cached;
      }
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}

export function modelCatalogRouter(getCatalog = createModelCatalog()) {
  const router = Router();
  router.get("/", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(await getCatalog(req.query.refresh === "1"));
    } catch {
      res.status(503).json({ error: "OpenRouter suggestions are unavailable. Retry or enter a model ID." });
    }
  });
  return router;
}
