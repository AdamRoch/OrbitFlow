import { redirect } from "next/navigation";

/** The run-scoped Monitoring board is OrbitFlow's only ticket view. */
export default function HomePage() {
  redirect("/monitoring?tab=board");
}
