import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonObject } from "../postgres/message-bus.ts";

export interface OpenClawWorkspaceAgent {
  name: string;
  role: string;
  system_prompt: string;
  memory: JsonObject;
}

export async function writeOpenClawWorkspace(
  workspace: string,
  agent: OpenClawWorkspaceAgent,
  workspaceTools: string | null = null,
  toolContext: JsonObject | null = null,
): Promise<void> {
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const toolsContent = workspaceTools?.trim()
    || "# Tools\n\nUse only tools allowed by the delivered node prompt.\n";
  const files: Record<string, string> = {
    "AGENTS.md":
      "Read SOUL.md and MEMORY.md before every turn. Follow the delivery prompt and return its fixed output contract exactly.\n",
    "SOUL.md": `${agent.system_prompt.trim()}\n`,
    "IDENTITY.md": `# ${agent.name}\n\n- Name: ${agent.name}\n- Role: ${agent.role}\n`,
    "MEMORY.md": [
      "# Canonical OrbitFlow memory",
      "",
      "Generated from PostgreSQL at wake time. Local edits are not authoritative.",
      "",
      "```json",
      JSON.stringify(agent.memory, null, 2),
      "```",
      "",
    ].join("\n"),
    "USER.md": "# User\n\nOrbitFlow delivers bounded workflow-node prompts.\n",
    "TOOLS.md": toolsContent,
    "HEARTBEAT.md": "# Heartbeat\n\nOrbitFlow owns scheduling and wake delivery.\n",
  };
  await Promise.all(
    Object.entries(files).map(async ([name, contents]) => {
      const target = path.join(workspace, name);
      const temporary = path.join(workspace, `.${name}.${process.pid}.tmp`);
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, target);
    }),
  );
  const contextTarget = path.join(workspace, ".orbitflow-tool-context.json");
  if (toolContext === null) {
    await unlink(contextTarget).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return;
  }
  const contextTemporary = path.join(workspace, `.orbitflow-tool-context.${process.pid}.tmp`);
  await writeFile(
    contextTemporary,
    `${JSON.stringify({ ...toolContext, workspace })}\n`,
    { mode: 0o600 },
  );
  await rename(contextTemporary, contextTarget);
}
