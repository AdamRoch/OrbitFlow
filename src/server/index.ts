import express from "express";
import { loadPublicAccessConfig, publicAccessMiddleware, previewOrigin, isPreviewHost } from "./public-access.js";
import { randomUUID } from "node:crypto";
import { resolve, extname } from "node:path";
import { migrate, query, pool } from "./db.js";
import { seed } from "./seed.js";
import { agentSchema, workflowSchema } from "./config.js";
import { modelCatalogRouter } from "./models.js";
import {
  listAgents,
  enqueue,
  getRun,
  cancel,
  resume,
  reconcileUsage,
  approve,
  log,
  bus,
  spent,
  startEngine,
} from "./engine.js";
import { runtimeVersion, runtimeAvailable } from "./runtime.js";
import {
  startIntegrations,
  nextScheduleWake,
  listScheduleStatuses,
} from "./integrations.js";
import type { Agent, Workflow, Run, Settings } from "../shared/types.js";

const port = Number(process.env.PORT ?? 4310),
  previewPort = Number(process.env.PREVIEW_PORT ?? 4312);
const app = express();
const access = loadPublicAccessConfig(process.env, port);
app.use(publicAccessMiddleware(access));
app.use((req, res, next) => {
  if (
    !["GET", "HEAD"].includes(req.method) &&
    !req.get("content-type")?.startsWith("application/json")
  )
    return res.status(415).json({ error: "Use application/json" });
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.json({ limit: "1mb" }));
app.get("/healthz", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.set("Cache-Control", "no-store").json({ ready: true });
  } catch {
    res.status(503).json({ ready: false });
  }
});
let configurationTail = Promise.resolve();
app.use("/api", (req, res, next) => {
  if (
    ["GET", "HEAD"].includes(req.method) ||
    !/^\/(agents|workflows|templates)(\/|$)/.test(req.path)
  )
    return next();
  const prior = configurationTail;
  let release!: () => void;
  configurationTail = new Promise<void>((r) => {
    release = r;
  });
  void prior.then(() => {
    if (res.destroyed) {
      release();
      return;
    }
    res.once("finish", release);
    res.once("close", release);
    next();
  });
});
app.get("/api/agents", async (_req, res) => res.json(await listAgents()));
app.use("/api/models", modelCatalogRouter());
app.get("/api/schedules", async (_req, res) =>
  res.json(await listScheduleStatuses(query, listAgents)),
);
async function validateAgent(body: unknown, id: string) {
  const agent = { ...agentSchema.parse(body), id } as Agent;
  if (
    agent.telegram &&
    (await listAgents()).some((a) => a.id !== id && a.telegram)
  )
    throw Error("Only one agent can own this Telegram bot");
  if (agent.schedule.enabled) {
    nextScheduleWake(agent.schedule.expression, new Date());
    if (!agent.schedule.prompt.trim())
      throw Error("Scheduled work needs a prompt");
    if (agent.schedule.workflowId) {
      const [scheduledWorkflow] = await query<{ data: Workflow }>(
        "SELECT data FROM workflows WHERE id=$1",
        [agent.schedule.workflowId],
      );
      if (!scheduledWorkflow) throw Error("Scheduled workflow does not exist");
      if (!scheduledWorkflow.data.nodes.some((node) => node.agentId === id))
        throw Error("Scheduled workflow must include this agent");
    }
  }
  return agent;
}
app.post("/api/agents", async (req, res) => {
  const a = await validateAgent(req.body, randomUUID());
  await query("INSERT INTO agents(id,data) VALUES($1,$2)", [a.id, a]);
  await log(null, "agent_saved", a.name);
  res.status(201).json(a);
});
app.put("/api/agents/:id", async (req, res) => {
  const a = await validateAgent(req.body, req.params.id);
  if (
    !(
      await query("UPDATE agents SET data=$2 WHERE id=$1 RETURNING id", [
        a.id,
        a,
      ])
    ).length
  )
    return res.status(404).json({ error: "Agent not found" });
  await log(null, "agent_saved", a.name);
  res.json(a);
});
app.delete("/api/agents/:id", async (req, res) => {
  const workflows = await query<{ data: Workflow }>(
    "SELECT data FROM workflows",
  );
  if (
    workflows.some((w) => w.data.nodes.some((n) => n.agentId === req.params.id))
  )
    throw Error("Remove this agent from workflows and templates first");
  await query("DELETE FROM agents WHERE id=$1", [req.params.id]);
  await log(null, "agent_deleted", "Agent deleted");
  res.json({ ok: true });
});
app.get("/api/workflows", async (_req, res) =>
  res.json(
    (
      await query<{ data: Workflow }>(
        "SELECT data FROM workflows WHERE template=false ORDER BY data->>'name'",
      )
    ).map((x) => x.data),
  ),
);
app.get("/api/templates", async (_req, res) =>
  res.json(
    (
      await query<{ data: Workflow }>(
        "SELECT data FROM workflows WHERE template=true ORDER BY id",
      )
    ).map((x) => x.data),
  ),
);
async function validateWorkflow(body: unknown, id: string) {
  const w = { ...workflowSchema.parse(body), id } as Workflow;
  const agents = await listAgents();
  if (w.nodes.some((n) => !agents.some((a) => a.id === n.agentId)))
    throw Error("Workflow references a missing agent");
  return w;
}
app.post("/api/workflows", async (req, res) => {
  const w = await validateWorkflow(req.body, randomUUID());
  await query("INSERT INTO workflows(id,data) VALUES($1,$2)", [w.id, w]);
  await log(null, "workflow_saved", w.name);
  res.status(201).json(w);
});
app.put("/api/workflows/:id", async (req, res) => {
  const w = await validateWorkflow(req.body, req.params.id);
  if (
    !(
      await query("UPDATE workflows SET data=$2 WHERE id=$1 RETURNING id", [
        w.id,
        w,
      ])
    ).length
  )
    return res.status(404).json({ error: "Workflow not found" });
  await log(null, "workflow_saved", w.name);
  res.json(w);
});
app.delete("/api/workflows/:id", async (req, res) => {
  if ((await listAgents()).some((a) => a.schedule.workflowId === req.params.id))
    throw Error("Remove this workflow from agent schedules first");
  await query("DELETE FROM workflows WHERE id=$1", [req.params.id]);
  await log(null, "workflow_deleted", "Workflow deleted");
  res.json({ ok: true });
});
app.post("/api/templates/:id/load", async (req, res) => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const rows = await c.query(
      "SELECT data FROM workflows WHERE id=$1 AND template=true",
      [req.params.id],
    );
    if (!rows.rows[0]) throw Error("Template not found");
    const w = structuredClone(rows.rows[0].data) as Workflow;
    w.id = randomUUID();
    w.name += " copy";
    const ids = new Map<string, string>();
    for (const n of w.nodes) {
      if (!ids.has(n.agentId)) {
        const a = (
          await c.query("SELECT data FROM agents WHERE id=$1", [n.agentId])
        ).rows[0]?.data as Agent | undefined;
        if (!a) throw Error("Template agent missing");
        const copy = {
          ...a,
          id: randomUUID(),
          name: a.name + " copy",
          telegram: false,
          schedule: { ...a.schedule, enabled: false, workflowId: null },
        };
        await c.query("INSERT INTO agents(id,data) VALUES($1,$2)", [
          copy.id,
          copy,
        ]);
        ids.set(n.agentId, copy.id);
      }
      n.agentId = ids.get(n.agentId)!;
    }
    await c.query("INSERT INTO workflows(id,data) VALUES($1,$2)", [w.id, w]);
    await c.query("COMMIT");
    await log(null, "template_loaded", w.name);
    res.status(201).json(w);
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
});
app.get("/api/runs", async (_req, res) =>
  res.json(
    (
      await query<{ data: Run }>(
        "SELECT data FROM runs ORDER BY created_at DESC LIMIT 100",
      )
    ).map((x) => x.data),
  ),
);
app.post("/api/runs", async (req, res) =>
  res
    .status(201)
    .json(
      await enqueue({
        workflowId: req.body.workflowId,
        agentId: req.body.agentId,
        prompt: req.body.prompt,
        parentRunId: req.body.parentRunId,
      }),
    ),
);
app.get("/api/runs/:id", async (req, res) => {
  const r = await getRun(req.params.id);
  if (!r) return res.status(404).json({ error: "Run not found" });
  res.json(r);
});
app.post("/api/runs/:id/cancel", async (req, res) =>
  res.json(await cancel(req.params.id)),
);
app.post("/api/runs/:id/resume", async (req, res) =>
  res.json(await resume(req.params.id)),
);
app.post("/api/runs/:id/usage-reconciliation", async (req, res) => {
  const { totalRunCostUsd, inputTokens, outputTokens, note } = req.body;
  if (!Number.isFinite(totalRunCostUsd) || totalRunCostUsd < 0)
    throw Error("totalRunCostUsd must be a finite nonnegative number");
  for (const [name, value] of [
    ["inputTokens", inputTokens],
    ["outputTokens", outputTokens],
  ] as const)
    if (value !== undefined && (!Number.isInteger(value) || value < 0))
      throw Error(`${name} must be a nonnegative integer when provided`);
  if (typeof note !== "string" || !note.trim() || note.trim().length > 2000)
    throw Error("A provider receipt note of 1–2,000 characters is required");
  res.json(
    await reconcileUsage(req.params.id, {
      totalRunCostUsd,
      inputTokens,
      outputTokens,
      note,
    }),
  );
});
app.post("/api/runs/:id/approval", async (req, res) => {
  if (typeof req.body.approved !== "boolean")
    throw Error("approved must be boolean");
  res.json(
    await approve(
      req.params.id,
      req.body.approved,
      req.body.feedback ?? "",
      req.body.approvalToken,
    ),
  );
});
app.get("/api/revisions/:id/source", async (req, res) => {
  const [v] = await query<{ files: Record<string, string> }>(
    "SELECT files FROM revisions WHERE id=$1",
    [req.params.id],
  );
  if (!v) return res.status(404).json({ error: "Revision not found" });
  res.json({
    files: Object.entries(v.files).map(([path, content]) => ({
      path,
      content,
    })),
  });
});
app.get("/api/revisions/:id/preview", async (req, res) => {
  const [v] = await query<{ files: Record<string, string> }>(
    "SELECT files FROM revisions WHERE id=$1",
    [req.params.id],
  );
  if (!v?.files["index.html"])
    return res
      .status(404)
      .json({ error: "Revision has no index.html preview" });
  const lineage = await previewLineage(req.params.id);
  res.json({
    url: `${previewOrigin(access, lineage, previewPort)}/r/${req.params.id}/index.html`,
  });
});
app.get("/api/settings", async (_req, res) => {
  res.json({
    unknownCostRuns: (
      await query("SELECT id FROM runs WHERE data->>'costUsd' IS NULL")
    ).length,
    runtime: "OpenCode",
    runtimeVersion,
    providerConfigured: Boolean(
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      process.env.OPENROUTER_API_KEY,
    ),
    budgetUsd: Number(process.env.ORBITFLOW_PROVIDER_BUDGET_USD ?? 0),
    spentUsd: await spent(),
    telegramConfigured: Boolean(
      process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID,
    ),
    telegramUsername: process.env.TELEGRAM_BOT_USERNAME ?? null,
    databaseReady: true,
  } satisfies Settings);
});
app.get("/api/events", async (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write(": connected\n\n");
  const send = (event: unknown) =>
    res.write(`event: update\ndata: ${JSON.stringify(event)}\n\n`);
  bus.on("update", send);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    bus.off("update", send);
  });
});
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Endpoint not found" }),
);
app.use(express.static(resolve("dist/web")));
app.get("/{*path}", (_req, res) =>
  res.sendFile(resolve("dist/web/index.html")),
);
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res
      .status(400)
      .json({
        error: err?.issues
          ? err.issues.map((x: any) => x.message).join("; ")
          : err instanceof Error
            ? err.message
            : "Request failed",
      });
  },
);
async function previewLineage(revisionId: string): Promise<string> {
  const [row] = await query<{ id: string }>(
    `WITH RECURSIVE lineage AS (
 SELECT r.id,r.data,0 depth FROM runs r JOIN revisions v ON v.run_id=r.id WHERE v.id=$1
 UNION ALL SELECT p.id,p.data,l.depth+1 FROM runs p JOIN lineage l ON p.id=l.data->>'parentRunId'
 ) SELECT id FROM lineage ORDER BY depth DESC LIMIT 1`,
    [revisionId],
  );
  return row?.id ?? "";
}
const preview = express();
preview.use((req, res, next) => {
  if (!(access.mode === "public"
    ? req.hostname.startsWith("app-") && req.hostname.endsWith(`.${access.previewBaseDomain}`)
    : /^app-[a-z0-9-]+\.localhost$/.test(req.hostname)))
    return res.sendStatus(403);
  res.set({
    "Content-Security-Policy":
      `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'; frame-ancestors ${access.mode === "public" ? access.publicOrigin : "http://127.0.0.1:4310 http://localhost:4310 http://127.0.0.1:4311 http://localhost:4311"}`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  next();
});
preview.get("/r/:id/{*path}", async (req, res) => {
  const [v] = await query<{ files: Record<string, string> }>(
    "SELECT files FROM revisions WHERE id=$1",
    [req.params.id],
  );
  const lineage = await previewLineage(req.params.id);
  if (!lineage || !isPreviewHost(access, req.hostname, lineage))
    return res.sendStatus(403);
  const path = Array.isArray(req.params.path)
    ? req.params.path.join("/")
    : (req.params.path ?? "index.html");
  const content = v?.files[path];
  if (content === undefined) return res.sendStatus(404);
  const mime: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
  };
  res.type(mime[extname(path)] ?? "text/plain").send(content);
});
await migrate();
await seed();
const stopEngine = await startEngine();
const integrations = await startIntegrations({
  query,
  listAgents,
  enqueue,
  approve,
  getRun,
  log,
});
const listenHost = access.mode === "public" ? "0.0.0.0" : "127.0.0.1";
const server = app.listen(port, listenHost, () =>
  console.log(`OrbitFlow http://127.0.0.1:${port}`),
);
const previewServer = preview.listen(previewPort, listenHost, () =>
  console.log(`Preview origin http://127.0.0.1:${previewPort}`),
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await integrations.stop();
  await stopEngine();
  server.close();
  previewServer.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
