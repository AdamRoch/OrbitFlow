export function GET() {
  return Response.json({
    status: "ready",
    persistence: "sqlite-foundation",
  });
}
