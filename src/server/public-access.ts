import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export type PublicAccessConfig =
  | {
      mode: "local";
      studioPort: number;
      previewBaseDomain: null;
    }
  | {
      mode: "public";
      studioPort: number;
      publicOrigin: string;
      studioHost: string;
      previewBaseDomain: string;
      operatorUsername: string;
      operatorPassword: string;
    };

type PublicAccessEnvironment = Record<string, string | undefined>;
const lineagePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;

export function loadPublicAccessConfig(
  env: PublicAccessEnvironment,
  studioPort: number,
): PublicAccessConfig {
  if (!Number.isInteger(studioPort) || studioPort < 1 || studioPort > 65535)
    throw Error("Invalid studio port");
  const origin = env.PUBLIC_ORIGIN;
  if (!origin) {
    if (env.PREVIEW_BASE_DOMAIN)
      throw Error("PREVIEW_BASE_DOMAIN requires PUBLIC_ORIGIN");
    return { mode: "local", studioPort, previewBaseDomain: null };
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw Error("PUBLIC_ORIGIN must be a canonical HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password ||
    !domainPattern.test(parsed.hostname)
  )
    throw Error("PUBLIC_ORIGIN must be a canonical HTTPS origin");
  const operatorUsername = env.ORBITFLOW_OPERATOR_USERNAME;
  const operatorPassword = env.ORBITFLOW_OPERATOR_PASSWORD;
  if (!operatorUsername || !operatorPassword || operatorUsername.includes(":"))
    throw Error("Public studio access requires operator credentials");
  const previewBaseDomain = env.PREVIEW_BASE_DOMAIN;
  if (!previewBaseDomain || !domainPattern.test(previewBaseDomain))
    throw Error("Public preview access requires PREVIEW_BASE_DOMAIN");
  return {
    mode: "public",
    studioPort,
    publicOrigin: origin,
    studioHost: parsed.host,
    previewBaseDomain,
    operatorUsername,
    operatorPassword,
  };
}

function equalSecret(actual: string, expected: string): boolean {
  const left = createHash("sha256").update(actual).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function authorizedBasic(header: string | undefined, config: Extract<PublicAccessConfig, { mode: "public" }>): boolean {
  const encoded = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(header ?? "")?.[1];
  if (!encoded || encoded.length > 8192) return false;
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) return false;
  const pair = decoded.toString("utf8");
  const separator = pair.indexOf(":");
  if (separator < 0) return false;
  const usernameMatches = equalSecret(
    pair.slice(0, separator),
    config.operatorUsername,
  );
  const passwordMatches = equalSecret(
    pair.slice(separator + 1),
    config.operatorPassword,
  );
  return usernameMatches && passwordMatches;
}

export function publicAccessMiddleware(config: PublicAccessConfig): RequestHandler {
  return (req, res, next) => {
    const publicHealth =
      config.mode === "public" &&
      req.method === "GET" &&
      req.path === "/healthz";
    if (config.mode === "public")
      res.setHeader("Cache-Control", "private, no-store");
    const host = req.get("host");
    const allowedHosts =
      config.mode === "public"
        ? [config.studioHost]
        : [
            `127.0.0.1:${config.studioPort}`,
            `localhost:${config.studioPort}`,
          ];
    if (
      !host ||
      (!allowedHosts.includes(host) &&
        !(publicHealth && host === "healthcheck.railway.app"))
    )
      return res.status(403).json({ error: "Host denied" });
    const origin = req.get("origin");
    const allowedOrigins =
      config.mode === "public"
        ? [config.publicOrigin]
        : [
            `http://127.0.0.1:${config.studioPort}`,
            `http://localhost:${config.studioPort}`,
            "http://127.0.0.1:4311",
            "http://localhost:4311",
          ];
    if (origin && !allowedOrigins.includes(origin))
      return res.status(403).json({ error: "Origin denied" });
    if (
      config.mode === "public" &&
      !publicHealth &&
      !authorizedBasic(req.get("authorization"), config)
    ) {
      res.setHeader("WWW-Authenticate", 'Basic realm="OrbitFlow"');
      return res.status(401).json({ error: "Operator authentication required" });
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  };
}

export function previewHost(config: PublicAccessConfig, lineage: string): string {
  if (!lineagePattern.test(lineage)) throw Error("Invalid preview lineage");
  return config.mode === "public"
    ? `app-${lineage}.${config.previewBaseDomain}`
    : `app-${lineage}.localhost`;
}

export function previewOrigin(
  config: PublicAccessConfig,
  lineage: string,
  localPreviewPort: number,
): string {
  const host = previewHost(config, lineage);
  return config.mode === "public"
    ? `https://${host}`
    : `http://${host}:${localPreviewPort}`;
}

export function isPreviewHost(
  config: PublicAccessConfig,
  actualHost: string,
  lineage: string,
): boolean {
  return actualHost === previewHost(config, lineage);
}
