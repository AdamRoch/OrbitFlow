import { getControlPlanePool } from "@/lib/control-plane";
import { assertRequiredMigrationHistory } from "../../../../scripts/migrate-postgres.mjs";

export async function GET() {
  try {
    const migration = await assertRequiredMigrationHistory(getControlPlanePool());
    return Response.json({
      status: "ready",
      persistence: "postgresql",
      migration: migration.version,
    });
  } catch {
    return Response.json(
      { status: "error", persistence: "postgresql" },
      { status: 503 },
    );
  }
}
