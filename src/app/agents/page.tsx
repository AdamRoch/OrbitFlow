import type { Metadata } from "next";
import { AgentEditor } from "@/components/agent-editor";

export const metadata: Metadata = {
  title: "Agents | OrbitFactory",
};

export default function AgentsPage() {
  return <AgentEditor />;
}
