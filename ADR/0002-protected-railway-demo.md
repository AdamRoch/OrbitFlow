# Protected Railway demo deployment

Status: accepted for Adam's production test, 2026-09-14. Updated September 16: real provider-backed cloud smoke and domain cutover completed; Adam's production walkthrough remains final acceptance. Evidence: docs/cloud-deployment-evidence.md.

Deploy v2 into the separate OrbitFlow-v2 Railway project, with a new PostgreSQL database. Keep the original project, deployment, database, bot, and fallback Railway URL for rollback. Do not migrate old runtime data. A CLI source upload avoids an unsolicited remote Git push.

The studio requires HTTPS and operator Basic authentication on assets, API, and SSE. It checks the canonical Host and Origin and sends private, no-store responses. A nonsecret database health endpoint is available to Railway. This is a single-operator demo boundary, not client identity management.

Generated previews use stable per-application origins under *.preview.orbitflow.adamroch.com on port 4312. The studio uses port 4310. Preview responses retain the restrictive CSP and cannot access studio credentials. Configure the wildcard DNS records using Railway's exact ownership and certificate instructions; use DNS-only records where Cloudflare's certificate coverage does not include the nested wildcard.

Normal Railway services do not provide the Docker boundary used locally. The pinned railway@3.11.0 SDK therefore creates one isolated Sandbox per agent turn from a credential-free checkpoint. The checkpoint holds the trusted runner and orbitflow-runtime:1.18.29. Only the selected provider credential enters that sandbox. A project/environment-scoped Railway token stays in the studio. The runner invokes the existing Docker boundary with UID 1000, restricted capabilities, and no host secrets or Docker socket inside the agent container.

PostgreSQL continues to own workflow routing, snapshots, approvals, messages, and revisions. The remote transport streams structured events and a terminal result or failure. Cancellation destroys the exact turn sandbox; a ten-minute idle limit bounds orphan lifetime. No model output controls cloud resource selection. Unknown provider usage continues to block further paid work.

Railway Sandboxes are experimental. Actual checkpoint creation, restoration, Docker execution, teardown, and provider runs must be reported separately from transport tests. This demo deployment is not a high-availability production claim. Run one studio replica because engine ownership is process-local. Use railway.json while supported (CLI reports support through 2026-12-01); replace that configuration before the announced removal.

The earlier $10 provider allowance is not reset by the new database. Historical local spending is $6.13760345, leaving at most $3.86239655. The candidate initially has budget zero and no provider or Telegram credentials. Enable paid work only after the remaining cloud prerequisites are ready; stop the local v2 bot consumer before enabling its cloud consumer. The original Telegram bot remains untouched.
