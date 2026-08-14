import { readFile, writeFile } from "node:fs/promises";

const [currentPath, templatePath] = process.argv.slice(2);
const template = JSON.parse(await readFile(templatePath, "utf8"));
let current;
try {
  current = JSON.parse(await readFile(currentPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  current = template;
}
current.tools = template.tools;
if (process.env.ORBITFLOW_OPENCLAW_BASE_URL) {
  template.models.providers.openrouter.baseUrl = process.env.ORBITFLOW_OPENCLAW_BASE_URL;
}
current.models = template.models;
current.agents = {
  ...(current.agents ?? {}),
  defaults: template.agents.defaults,
};
current.channels = {
  ...(current.channels ?? {}),
  telegram: template.channels.telegram,
};
await writeFile(currentPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
