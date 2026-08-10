import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterAll, beforeAll } from "vitest";

type JsonResult = Promise<{ status: number; body: any }>;

export interface Harness {
  base: string;
  dbPath: string;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  createIssue: (body: Record<string, unknown>) => JsonResult;
  getIssue: (id: string) => JsonResult;
  frontier: () => JsonResult;
  listIssues: (query?: string) => JsonResult;
  claim: (id: string) => JsonResult;
  patchIssue: (id: string, body: Record<string, unknown>) => JsonResult;
  deleteIssue: (id: string) => Promise<{ status: number }>;
  setLabels: (id: string, labelNames: string[]) => JsonResult;
  listLabels: () => JsonResult;
  createLabel: (body: Record<string, unknown>) => JsonResult;
  deleteLabel: (id: number) => Promise<{ status: number }>;
  addBlocker: (id: string, blockerId: string | number) => JsonResult;
  removeBlocker: (id: string, blockerId: string) => Promise<{ status: number }>;
  getBlockers: (id: string) => JsonResult;
}

async function jsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createHarness(): Harness {
  let processHandle: ChildProcess | null = null;
  let base = "";
  let dbPath = "";

  const harness = {
    base: "",
    dbPath: "",
    fetch: async () => {
      throw new Error("test server is not ready");
    },
  } as unknown as Harness;

  const request = async (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

  const jsonRequest = async (
    path: string,
    init?: RequestInit,
  ): JsonResult => {
    const response = await request(path, init);
    return { status: response.status, body: await jsonResponse(response) };
  };

  beforeAll(async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "orbitfactory-test-"));
    dbPath = join(tempDirectory, "test.db");
    const port = await freePort();

    processHandle = spawn("npx", ["next", "dev", "-p", String(port)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ORBITFACTORY_DB_PATH: dbPath,
        ORBITFACTORY_SEED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    base = `http://127.0.0.1:${port}`;
    harness.base = base;
    harness.dbPath = dbPath;
    harness.fetch = request;
    harness.createIssue = (body) =>
      jsonRequest("/api/issues", { method: "POST", body: JSON.stringify(body) });
    harness.getIssue = (id) => jsonRequest(`/api/issues/${id}`);
    harness.frontier = () => jsonRequest("/api/issues/frontier");
    harness.listIssues = (query = "") => jsonRequest(`/api/issues${query}`);
    harness.claim = (id) =>
      jsonRequest(`/api/issues/${id}/claim`, { method: "POST" });
    harness.patchIssue = (id, body) =>
      jsonRequest(`/api/issues/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    harness.deleteIssue = async (id) => {
      const response = await request(`/api/issues/${id}`, { method: "DELETE" });
      return { status: response.status };
    };
    harness.setLabels = (id, labelNames) =>
      jsonRequest(`/api/issues/${id}/labels`, {
        method: "PUT",
        body: JSON.stringify({ labelNames }),
      });
    harness.listLabels = () => jsonRequest("/api/labels");
    harness.createLabel = (body) =>
      jsonRequest("/api/labels", { method: "POST", body: JSON.stringify(body) });
    harness.deleteLabel = async (id) => {
      const response = await request(`/api/labels/${id}`, { method: "DELETE" });
      return { status: response.status };
    };
    harness.addBlocker = (id, blockerId) =>
      jsonRequest(`/api/issues/${id}/blockers`, {
        method: "POST",
        body: JSON.stringify({ blockerId }),
      });
    harness.removeBlocker = async (id, blockerId) => {
      const response = await request(`/api/issues/${id}/blockers/${blockerId}`, {
        method: "DELETE",
      });
      return { status: response.status };
    };
    harness.getBlockers = (id) => jsonRequest(`/api/issues/${id}/blockers`);

    if (!(await waitFor(`${base}/api/issues`, 45_000))) {
      throw new Error(`Next dev server did not become ready.\n${await readStderr(processHandle)}`);
    }
  }, 60_000);

  afterAll(async () => {
    if (processHandle) {
      processHandle.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!processHandle.killed) processHandle.kill("SIGKILL");
    }
    if (dbPath) {
      rmSync(dbPath.replace(/\/[^/]+$/, ""), { recursive: true, force: true });
    }
  });

  return harness;
}

async function waitFor(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return true;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function readStderr(processHandle: ChildProcess | null): Promise<string> {
  if (!processHandle?.stderr) return "";
  let output = "";
  processHandle.stderr.on("data", (chunk) => (output += chunk.toString()));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return output.slice(-3000);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        resolve(typeof address === "object" && address ? address.port : 0),
      );
    });
  });
}
