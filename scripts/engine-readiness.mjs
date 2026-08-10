import http from "node:http";
import pg from "pg";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the engine readiness service");
}

// Compose health checks and service-to-service callers need a stable internal
// address. Host publication is configured separately in compose.yaml.
const port = 3001;

const pool = new Pool({
  connectionString: databaseUrl,
  application_name: "orbitfactory-engine-readiness",
});

async function databaseIsReady() {
  await pool.query("SELECT 1");
}

await databaseIsReady();

const server = http.createServer(async (request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"live"}\n');
    return;
  }

  if (request.url === "/readyz") {
    try {
      await databaseIsReady();
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ready","workflowEngine":"not_implemented"}\n');
    } catch {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"status":"not_ready"}\n');
    }
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end('{"error":"not_found"}\n');
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Engine foundation readiness listening on ${port}\n`);
});

async function shutdown() {
  server.close();
  await pool.end();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown().finally(() => process.exit(0));
  });
}
