import type { Metadata } from "next";
import { AgentEditor } from "@/components/agent-editor";
import { parseOpenClawModelCatalog } from "@/lib/runtime/openclaw-model-catalog.mjs";
import openClawConfig from "../../../docker/openclaw/openclaw.json";

export const metadata: Metadata = {
  title: "Agents | OrbitFactory",
};

export default function AgentsPage() {
  const catalog = parseOpenClawModelCatalog(openClawConfig);
  return <AgentEditor availableModels={catalog.availableModels} primaryModel={catalog.primaryModel} />;
}
