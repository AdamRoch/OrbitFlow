import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("claim race writer requires a parent port");

const database = new Database(workerData.dbPath);
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
database.pragma("busy_timeout = 5000");
database.exec("BEGIN IMMEDIATE");

if (workerData.mutation === "cancel") {
  database
    .prepare("UPDATE issues SET status = 'canceled' WHERE id = ?")
    .run(workerData.issueId);
} else if (workerData.mutation === "block") {
  database
    .prepare(
      "INSERT INTO dependencies (blocker_issue_id, blocked_issue_id) VALUES (?, ?)",
    )
    .run(workerData.blockerIssueId, workerData.issueId);
} else {
  throw new Error(`unknown race mutation: ${workerData.mutation}`);
}

parentPort.postMessage("write-ready");

const claimSignal = new Int32Array(workerData.claimSignal);
Atomics.wait(claimSignal, 0, 0, 250);
const staleReadObserved = Atomics.load(claimSignal, 0) === 1;

database.exec("COMMIT");
database.close();
parentPort.postMessage({ type: "committed", staleReadObserved });
