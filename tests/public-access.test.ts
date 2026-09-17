import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import express from "express";
import {
  loadPublicAccessConfig,
  publicAccessMiddleware,
  previewHost,
  previewOrigin,
  isPreviewHost,
} from "../src/server/public-access.js";

const publicEnvironment = {
  PUBLIC_ORIGIN: "https://orbitflow.adamroch.com",
  PREVIEW_BASE_DOMAIN: "preview.orbitflow.adamroch.com",
  ORBITFLOW_OPERATOR_USERNAME: "adam",
  ORBITFLOW_OPERATOR_PASSWORD: "a private test value",
};

async function probe(
  mode: "local" | "public",
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<{ status: number; body: string; challenge?: string; cacheControl?: string }> {
  const app = express();
  const config = loadPublicAccessConfig(
    mode === "public" ? publicEnvironment : {},
    4310,
  );
  app.use(publicAccessMiddleware(config));
  app.get("/healthz", (_req, res) => res.json({ ready: true }));
  app.get("/api/agents", (_req, res) => res.json([]));
  app.get("/api/events", (_req, res) => res.type("text/event-stream").send(": ready\n\n"));
  app.get("/", (_req, res) => res.send("studio"));
  app.post("/api/agents", (_req, res) => res.send("saved"));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No test port");
    return await new Promise((resolve, reject) => {
      const operation = request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path,
          method,
          headers,
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (part) => (body += part));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body,
              challenge: response.headers["www-authenticate"] as string | undefined,
              cacheControl: response.headers["cache-control"] as string | undefined,
            }),
          );
        },
      );
      operation.on("error", reject);
      operation.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("public configuration fails closed before startup", () => {
  assert.throws(
    () => loadPublicAccessConfig({ ...publicEnvironment, ORBITFLOW_OPERATOR_PASSWORD: "" }, 4310),
    /operator credentials/,
  );
  assert.throws(
    () => loadPublicAccessConfig({ ...publicEnvironment, PREVIEW_BASE_DOMAIN: "" }, 4310),
    /PREVIEW_BASE_DOMAIN/,
  );
  for (const bad of [
    "http://orbitflow.adamroch.com",
    "https://orbitflow.adamroch.com/path",
    "https://orbitflow.adamroch.com/",
  ])
    assert.throws(
      () => loadPublicAccessConfig({ ...publicEnvironment, PUBLIC_ORIGIN: bad }, 4310),
      /canonical HTTPS origin/,
    );
});

test("public studio requires Basic auth for assets, API and SSE", async () => {
  const host = "orbitflow.adamroch.com";
  const credential = `Basic ${Buffer.from("adam:a private test value").toString("base64")}`;
  for (const path of ["/", "/api/agents", "/api/events"]) {
    const denied = await probe("public", path, { Host: host });
    assert.equal(denied.status, 401);
    assert.equal(denied.challenge, 'Basic realm="OrbitFlow"');
    assert.equal(denied.cacheControl, "private, no-store");
    const served = await probe("public", path, { Host: host, Authorization: credential });
    assert.equal(served.status, 200);
    assert.equal(served.cacheControl, "private, no-store");
  }
  assert.equal(
    (await probe("public", "/api/agents", { Host: host, Authorization: `Basic ${Buffer.from("adam:wrong").toString("base64")}` })).status,
    401,
  );
  assert.equal(
    (await probe("public", "/healthz", { Host: "healthcheck.railway.app" })).status,
    200,
  );
  assert.equal(
    (await probe("public", "/api/agents", { Host: "healthcheck.railway.app", Authorization: credential })).status,
    403,
  );
});

test("public host and origin must be canonical, regardless of forwarded host", async () => {
  const credential = `Basic ${Buffer.from("adam:a private test value").toString("base64")}`;
  assert.equal(
    (await probe("public", "/api/agents", {
      Host: "foreign.example.com",
      "X-Forwarded-Host": "orbitflow.adamroch.com",
      Authorization: credential,
    })).status,
    403,
  );
  assert.equal(
    (await probe("public", "/api/agents", {
      Host: "orbitflow.adamroch.com",
      Origin: "https://foreign.example.com",
      Authorization: credential,
    })).status,
    403,
  );
  assert.equal(
    (await probe("public", "/api/agents", {
      Host: "orbitflow.adamroch.com",
      Origin: "https://orbitflow.adamroch.com",
      Authorization: credential,
    })).status,
    200,
  );
});

test("local default stays unauthenticated but loopback-only", async () => {
  assert.equal((await probe("local", "/", { Host: "127.0.0.1:4310" })).status, 200);
  assert.equal((await probe("local", "/", { Host: "localhost:4310" })).status, 200);
  assert.equal((await probe("local", "/", { Host: "foreign.example.com" })).status, 403);
  assert.equal((await probe("local", "/", { Host: "127.0.0.1:4310", Origin: "http://foreign.example.com" })).status, 403);
});

test("preview hosts stay separate by exact application lineage", () => {
  const publicConfig = loadPublicAccessConfig(publicEnvironment, 4310);
  const localConfig = loadPublicAccessConfig({}, 4310);
  assert.equal(previewHost(publicConfig, "abc-123"), "app-abc-123.preview.orbitflow.adamroch.com");
  assert.equal(previewOrigin(publicConfig, "abc-123", 4312), "https://app-abc-123.preview.orbitflow.adamroch.com");
  assert.equal(previewOrigin(localConfig, "abc-123", 4312), "http://app-abc-123.localhost:4312");
  assert.equal(isPreviewHost(publicConfig, "app-abc-123.preview.orbitflow.adamroch.com", "abc-123"), true);
  assert.equal(isPreviewHost(publicConfig, "app-other.preview.orbitflow.adamroch.com", "abc-123"), false);
  assert.throws(() => previewHost(publicConfig, "abc.example.com"), /Invalid preview lineage/);
});
