import { Pool } from "pg";
import { ControlPlaneRepository } from "./repository";

let pool: Pool | null = null;
let repository: ControlPlaneRepository | null = null;

/** Lazily create the PostgreSQL control-plane connection pool. */
export function getControlPlaneRepository(): ControlPlaneRepository {
  if (repository) return repository;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the PostgreSQL control plane");
  }
  pool = new Pool({
    connectionString,
    application_name: "orbitfactory-control-plane",
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
  repository = new ControlPlaneRepository(pool);
  return repository;
}

/** Shared PostgreSQL pool for engine-adjacent API actions such as schedule ticks. */
export function getControlPlanePool(): Pool {
  getControlPlaneRepository();
  return pool!;
}

export { ControlPlaneRepository } from "./repository";
export * from "./types";
