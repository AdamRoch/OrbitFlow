import { readFile } from "node:fs/promises";
import path from "node:path";
import { WorkspaceError } from "./errors.js";

export const DEPLOYMENT_MANIFEST = "orbitflow.deploy.json";

export async function requireDeploymentManifest(workspace, outputMode) {
  if (outputMode === "downloadable") return null;
  if (outputMode !== "web_service" && outputMode !== "railway_app") {
    throw new WorkspaceError("Software Factory output mode is invalid");
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(workspace, DEPLOYMENT_MANIFEST), "utf8"));
  } catch {
    throw new WorkspaceError(`${DEPLOYMENT_MANIFEST} is missing or invalid`);
  }
  requireExactKeys(manifest, [
    "buildCommand",
    "healthPath",
    "port",
    "publishIntent",
    "requiredEnvironmentVariables",
    "schemaVersion",
    "startCommand",
  ]);
  if (manifest.schemaVersion !== 1) throw new WorkspaceError("deployment manifest version is invalid");
  for (const field of ["buildCommand", "startCommand"]) {
    if (typeof manifest[field] !== "string" || manifest[field].trim() === "") {
      throw new WorkspaceError(`deployment manifest ${field} is invalid`);
    }
  }
  if (typeof manifest.healthPath !== "string" || !/^\/[A-Za-z0-9/_-]*$/.test(manifest.healthPath)) {
    throw new WorkspaceError("deployment manifest healthPath is invalid");
  }
  requireExactKeys(manifest.port, ["default", "environmentVariable"]);
  if (
    manifest.port.environmentVariable !== "PORT" ||
    !Number.isSafeInteger(manifest.port.default) ||
    manifest.port.default < 1 ||
    manifest.port.default > 65_535
  ) {
    throw new WorkspaceError("deployment manifest port behavior is invalid");
  }
  if (
    !Array.isArray(manifest.requiredEnvironmentVariables) ||
    new Set(manifest.requiredEnvironmentVariables).size !== manifest.requiredEnvironmentVariables.length ||
    manifest.requiredEnvironmentVariables.some(
      (name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name) || name === "PORT",
    )
  ) {
    throw new WorkspaceError("deployment manifest required environment variables are invalid");
  }
  const expectedIntent = outputMode === "railway_app" ? "railway" : "none";
  if (manifest.publishIntent !== expectedIntent) {
    throw new WorkspaceError("deployment manifest publishing intent does not match the run spec");
  }
  return manifest;
}

function requireExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceError("deployment manifest must be one object");
  }
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new WorkspaceError("deployment manifest has unexpected fields");
  }
}
