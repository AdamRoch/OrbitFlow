import pg from "pg";
export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://orbitflow:orbitflow-local@127.0.0.1:54329/orbitflow_v2",
  max: 8,
});
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await pool.query(sql, params)).rows;
}
export async function migrate() {
  await pool.query(`
CREATE TABLE IF NOT EXISTS agents(id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS workflows(id text PRIMARY KEY, data jsonb NOT NULL, template boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS runs(id text PRIMARY KEY, data jsonb NOT NULL, snapshot jsonb NOT NULL, idempotency_key text UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS messages(id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS events(id bigserial PRIMARY KEY, run_id text REFERENCES runs(id), kind text NOT NULL, content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS revisions(id text PRIMARY KEY,run_id text NOT NULL REFERENCES runs(id), files jsonb NOT NULL, approved boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS integration_state(key text PRIMARY KEY,value jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS runs_status ON runs((data->>'status'));
CREATE INDEX IF NOT EXISTS messages_run ON messages(run_id,created_at);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id,id);
`);
}
