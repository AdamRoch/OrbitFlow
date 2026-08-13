import { writeFile } from "node:fs/promises";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("tool environment output path is required");

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const optional = (name) => process.env[name] || null;

await writeFile(outputPath, `${JSON.stringify({
  agentWorkspaceRoot: required("ORBITFLOW_AGENT_WORKSPACE_ROOT"),
  codingTimeoutMs: optional("ORBITFLOW_CODING_TIMEOUT_MS"),
  databaseUrl: required("DATABASE_URL"),
  openCodeBinary: optional("ORBITFLOW_OPENCODE_BINARY"),
  openCodeModel: optional("ORBITFLOW_OPENCODE_MODEL"),
  openRouterApiKey: optional("OPENROUTER_API_KEY"),
  workspaceRoot: required("ORBITFLOW_WORKSPACE_ROOT"),
})}\n`, { mode: 0o600 });
