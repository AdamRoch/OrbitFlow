import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

function matches(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);

  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="OrbitFlow", charset="UTF-8"' },
  });
}

export function proxy(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname === "/api/health") {
    return NextResponse.next();
  }

  const username = process.env.ORBITFLOW_OPERATOR_USERNAME;
  const password = process.env.ORBITFLOW_OPERATOR_PASSWORD;

  if (!username || !password) {
    return new NextResponse("Operator authentication is not configured", {
      status: 503,
    });
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) return unauthorized();

  try {
    const credentials = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = credentials.indexOf(":");

    if (
      separator < 0 ||
      !matches(credentials.slice(0, separator), username) ||
      !matches(credentials.slice(separator + 1), password)
    ) {
      return unauthorized();
    }
  } catch {
    return unauthorized();
  }

  return NextResponse.next();
}
