import type { Metadata } from "next";
import { WorkflowEditor } from "@/components/workflow-editor";

export const metadata: Metadata = {
  title: "Workflows | OrbitFactory",
};

export default function WorkflowsPage() {
  return <WorkflowEditor />;
}
