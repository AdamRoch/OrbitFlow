import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  // better-sqlite3 is a native module; keep it out of the server bundle so
  // Next loads it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
