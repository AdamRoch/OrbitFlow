import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";
import { PROJECT_PREFIX } from "../config";

const { labels, projects } = schema;

export type DB = BetterSQLite3Database<typeof schema>;

function dbPath(): string {
  const configuredPath = process.env.ORBITFACTORY_DB_PATH;
  if (configuredPath) return resolve(configuredPath);
  return resolve(process.cwd(), "data", "orbitfactory.db");
}

let cachedDb: DB | null = null;
let cachedPath: string | null = null;
let rawDb: Database.Database | null = null;

export function getDb(): DB {
  const path = dbPath();
  if (cachedDb && cachedPath === path) return cachedDb;

  cachedPath = path;
  mkdirSync(dirname(path), { recursive: true });
  rawDb = new Database(path);
  configure(rawDb);
  cachedDb = drizzle(rawDb, { schema });
  return cachedDb;
}

export function createDb(path: string): { db: DB; raw: Database.Database } {
  const raw = new Database(path);
  configure(raw);
  return { db: drizzle(raw, { schema }), raw };
}

export function resetDbCache(): void {
  if (rawDb) {
    try {
      rawDb.close();
    } catch {
      // The connection may already be closed by a test or process shutdown.
    }
  }
  cachedDb = null;
  cachedPath = null;
  rawDb = null;
}

function configure(raw: Database.Database): void {
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      key         TEXT    NOT NULL UNIQUE,
      name        TEXT    NOT NULL,
      next_number INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS issues (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      number      INTEGER NOT NULL,
      identifier  TEXT    NOT NULL UNIQUE,
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title       TEXT    NOT NULL,
      description TEXT,
      status      TEXT    NOT NULL DEFAULT 'backlog',
      priority    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS labels (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT    NOT NULL UNIQUE,
      color TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS issue_labels (
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (issue_id, label_id)
    );

    CREATE TABLE IF NOT EXISTS dependencies (
      blocker_issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      blocked_issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      PRIMARY KEY (blocker_issue_id, blocked_issue_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS issues_project_number_unique
      ON issues(project_id, number);
    CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
    CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
    CREATE INDEX IF NOT EXISTS idx_deps_blocked ON dependencies(blocked_issue_id);
    CREATE INDEX IF NOT EXISTS idx_deps_blocker ON dependencies(blocker_issue_id);
  `);

  raw.prepare(
    `INSERT OR IGNORE INTO projects (key, name, next_number, created_at)
     VALUES (?, 'OrbitFactory', 0, ?)`,
  ).run(PROJECT_PREFIX, Date.now());
}

const DEFAULT_LABELS = [
  { name: "bug", color: "#ef4444" },
  { name: "feature", color: "#8b5cf6" },
  { name: "docs", color: "#3b82f6" },
] as const;

export function seedDefaultsIfNeeded(
  db: DB,
  defaults: readonly { name: string; color: string }[] = DEFAULT_LABELS,
): void {
  const existing = db.select({ id: labels.id }).from(labels).limit(1).get();
  if (existing) return;
  for (const label of defaults) {
    db.insert(labels).values(label).onConflictDoNothing().run();
  }
}

export function getDefaultProject(db: DB): schema.ProjectRow | null {
  return db.select().from(projects).orderBy(projects.id).limit(1).get() ?? null;
}

export function nextIssueNumber(db: DB, projectId: number): number {
  const row = db
    .get<{ next_number: number }>(
      sql`UPDATE projects SET next_number = next_number + 1 WHERE id = ${projectId} RETURNING next_number`,
    );
  if (!row) throw new Error("ticket scope not found");
  return row.next_number;
}
