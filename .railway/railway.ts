import { defineRailway, postgres, preserve, project, service, volume } from "railway/iac";

const REGION = "sfo";
const CUSTOM_DOMAIN = "orbitflow.adamroch.com";

export default defineRailway((ctx) => {
  const production = ctx.isEnvironment("production");

  const database = postgres("orbitflow-postgres", { region: REGION });
  const platformWorkspaces = volume("platform-workspaces", {
    region: REGION,
    sizeMB: 5_000,
  });
  const openclawState = volume("openclaw-state", {
    region: REGION,
    sizeMB: 5_000,
  });

  const web = service("web", {
    replicas: { [REGION]: 1 },
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    env: {
      DATABASE_URL: database.env.DATABASE_URL,
      NODE_ENV: "production",
      ORBITFLOW_OPERATOR_PASSWORD: preserve(),
      ORBITFLOW_OPERATOR_USERNAME: preserve(),
      PORT: "3000",
      RAILWAY_DOCKERFILE_PATH: "Dockerfile",
    },
  });

  const platform = service("platform", {
    replicas: { [REGION]: 1 },
    healthcheck: "/readyz",
    healthcheckTimeout: 180,
    volumeMounts: {
      "/var/lib/orbitflow": platformWorkspaces,
    },
    env: {
      DATABASE_URL: database.env.DATABASE_URL,
      ORBITFLOW_AGENT_WORKSPACE_ROOT: "/var/lib/orbitflow/runtime/workspaces",
      ORBITFLOW_CODING_EXECUTOR_TOKEN: preserve(),
      ORBITFLOW_CODING_EXECUTOR_URL: "http://${{coding-executor.RAILWAY_PRIVATE_DOMAIN}}:3005",
      ORBITFLOW_OPENCLAW_RUNTIME_TOKEN: preserve(),
      ORBITFLOW_OPENCLAW_RUNTIME_URL: "http://${{openclaw-runtime.RAILWAY_PRIVATE_DOMAIN}}:3004",
      ORBITFLOW_RUNTIME_ROOT: "/var/lib/orbitflow/runtime",
      ORBITFLOW_TOOL_BROKER_PORT: "3003",
      ORBITFLOW_TOOL_BROKER_REMOTE_CONTEXT: "1",
      ORBITFLOW_TOOL_BROKER_TOKEN: preserve(),
      ORBITFLOW_WORKSPACE_ROOT: "/var/lib/orbitflow/run-workspaces",
      PORT: "3001",
      RAILWAY_DOCKERFILE_PATH: "Dockerfile",
    },
  });

  const openclawRuntime = service("openclaw-runtime", {
    replicas: { [REGION]: 1 },
    healthcheck: "/readyz",
    healthcheckTimeout: 180,
    volumeMounts: {
      "/var/lib/orbitflow": openclawState,
    },
    env: {
      OPENCLAW_DISABLE_BONJOUR: "1",
      OPENCLAW_STATE_DIR: "/var/lib/orbitflow/openclaw",
      OPENROUTER_API_KEY: preserve(),
      ORBITFLOW_RUNTIME_ROOT: "/var/lib/orbitflow/runtime",
      ORBITFLOW_RUNTIME_RPC_PORT: "3004",
      ORBITFLOW_RUNTIME_RPC_TOKEN: preserve(),
      ORBITFLOW_TOOL_BROKER_TOKEN: preserve(),
      ORBITFLOW_TOOL_BROKER_URL: "http://${{platform.RAILWAY_PRIVATE_DOMAIN}}:3003",
      PORT: "3004",
      RAILWAY_DOCKERFILE_PATH: "Dockerfile",
    },
  });

  const codingExecutor = service("coding-executor", {
    replicas: { [REGION]: 1 },
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    env: {
      OPENROUTER_API_KEY: preserve(),
      ORBITFLOW_CODING_EXECUTOR_PORT: "3005",
      ORBITFLOW_CODING_EXECUTOR_ROOT: "/tmp/orbitflow-coding-executor",
      ORBITFLOW_CODING_EXECUTOR_TOKEN: preserve(),
      PORT: "3005",
      RAILWAY_DOCKERFILE_PATH: "Dockerfile",
    },
  });

  const telegram = service("telegram", {
    replicas: { [REGION]: 1 },
    healthcheck: "/readyz",
    healthcheckTimeout: 120,
    env: {
      DATABASE_URL: database.env.DATABASE_URL,
      ORBITFLOW_TELEGRAM_ALLOWED_CHAT_IDS: preserve(),
      ORBITFLOW_TELEGRAM_HEALTH_PORT: "3002",
      PORT: "3002",
      RAILWAY_DOCKERFILE_PATH: "Dockerfile",
      TELEGRAM_BOT_TOKEN: preserve(),
    },
  });

  const migrate = service("migrate", {
    replicas: { [REGION]: 1 },
    env: {
      DATABASE_URL: database.env.DATABASE_URL,
      RAILWAY_DOCKERFILE_PATH: "Dockerfile",
    },
  });

  const resources = [
    web,
    platform,
    openclawRuntime,
    codingExecutor,
    telegram,
    migrate,
    database,
    platformWorkspaces,
    openclawState,
  ];

  if (production) {
    const legacyPostgres = postgres("Postgres", { region: REGION });
    const legacyPostgresVolume = volume("postgres-volume", {
      alerts: { usage: { "80": {}, "95": {}, "100": {} } },
      allowOnlineResize: true,
      region: REGION,
      sizeMB: 50_000,
    });
    const legacyAppVolume = volume("app-volume", {
      alerts: { usage: { "80": {}, "95": {}, "100": {} } },
      allowOnlineResize: true,
      region: REGION,
      sizeMB: 50_000,
    });
    const legacyApp = service("app", {
      replicas: { [REGION]: 1 },
      domains: [CUSTOM_DOMAIN],
      volumeMounts: { "/app/data": legacyAppVolume },
      env: {
        DATABASE_URL: preserve(),
        ORBITFACTORY_DB_PATH: preserve(),
        RAILWAY_DOCKERFILE_PATH: preserve(),
      },
    });
    resources.push(legacyApp, legacyPostgres, legacyPostgresVolume, legacyAppVolume);
  }

  return project("OrbitFlow", { resources });
});
