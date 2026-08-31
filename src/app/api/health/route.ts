import { getControlPlanePool } from "@/lib/control-plane";

export async function GET() {
  try {
    await getControlPlanePool().query("SELECT 1");
    return Response.json({ status: "ready", persistence: "postgresql" });
  } catch {
    return Response.json(
      { status: "error", persistence: "postgresql" },
      { status: 503 },
    );
  }
}
