import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { claimIssue, createIssue } from "@/lib/domain";
import { createDb, getDefaultProject } from "@/lib/db";
import * as schema from "@/lib/db/schema";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createTicketDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "orbitfactory-claim-race-"));
  tempDirectories.push(directory);
  const dbPath = join(directory, "test.db");
  const connection = createDb(dbPath);
  const project = getDefaultProject(connection.db);
  if (!project) throw new Error("default project was not created");
  return { ...connection, dbPath, project };
}

function startRaceWriter(workerData: Record<string, unknown>) {
  const worker = new Worker(
    new URL("./fixtures/claim-race-writer.mjs", import.meta.url),
    { workerData },
  );
  const ready = new Promise<void>((resolve, reject) => {
    worker.once("message", (message) => {
      if (message === "write-ready") resolve();
      else reject(new Error(`unexpected worker message: ${String(message)}`));
    });
    worker.once("error", reject);
  });
  const completed = new Promise<void>((resolve, reject) => {
    worker.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`race writer exited with code ${code}`));
    });
    worker.once("error", reject);
  });
  const staleReadObserved = new Promise<boolean>((resolve, reject) => {
    worker.on("message", (message) => {
      if (message?.type === "committed") resolve(message.staleReadObserved);
    });
    worker.once("error", reject);
  });
  return { ready, completed, staleReadObserved };
}

function openObservedClaimConnection(dbPath: string, claimSignal: Int32Array) {
  const raw = new Database(dbPath, {
    verbose(statement) {
      if (
        typeof statement === "string" &&
        statement.trimStart().toLowerCase().startsWith("select")
      ) {
        Atomics.store(claimSignal, 0, 1);
        Atomics.notify(claimSignal, 0);
      }
    },
  });
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");
  return { raw, db: drizzle(raw, { schema }) };
}

describe("claimIssue concurrency", () => {
  it("cannot overwrite a cancel committed after a stale todo snapshot", async () => {
    const bootstrap = createTicketDatabase();
    const issue = createIssue(bootstrap.db, bootstrap.project, {
      title: "cancel during claim",
      description: null,
      status: "todo",
    });
    bootstrap.raw.close();
    const claimSignal = new Int32Array(new SharedArrayBuffer(4));
    const writer = startRaceWriter({
      dbPath: bootstrap.dbPath,
      mutation: "cancel",
      issueId: issue.id,
      claimSignal: claimSignal.buffer,
    });

    await writer.ready;
    const claimConnection = openObservedClaimConnection(
      bootstrap.dbPath,
      claimSignal,
    );
    const result = claimIssue(
      claimConnection.db,
      bootstrap.project,
      issue.identifier,
    );
    const staleReadObserved = await writer.staleReadObserved;
    await writer.completed;

    expect(staleReadObserved).toBe(false);
    expect(result).toEqual({
      ok: false,
      reason: "not_claimable",
      status: "canceled",
    });
    claimConnection.raw.close();
  });

  it("cannot claim a ticket blocked by a concurrent committed edge", async () => {
    const bootstrap = createTicketDatabase();
    const blocker = createIssue(bootstrap.db, bootstrap.project, {
      title: "concurrent blocker",
      description: null,
      status: "todo",
    });
    const blocked = createIssue(bootstrap.db, bootstrap.project, {
      title: "blocked during claim",
      description: null,
      status: "todo",
    });
    bootstrap.raw.close();
    const claimSignal = new Int32Array(new SharedArrayBuffer(4));
    const writer = startRaceWriter({
      dbPath: bootstrap.dbPath,
      mutation: "block",
      issueId: blocked.id,
      blockerIssueId: blocker.id,
      claimSignal: claimSignal.buffer,
    });

    await writer.ready;
    const claimConnection = openObservedClaimConnection(
      bootstrap.dbPath,
      claimSignal,
    );
    const result = claimIssue(
      claimConnection.db,
      bootstrap.project,
      blocked.identifier,
    );
    const staleReadObserved = await writer.staleReadObserved;
    await writer.completed;

    expect(staleReadObserved).toBe(false);
    expect(result).toEqual({ ok: false, reason: "blocked" });
    claimConnection.raw.close();
  });
});
