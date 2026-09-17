# Production test deployment

Live studio: https://orbitflow.adamroch.com . V2 domain cutover completed September 16, 2026; the GitHub source transition completed September 17. Initial GitHub deployment `a6e749fb-10bd-4bd9-baa1-48763e33396c` succeeded with merge commit `97618b2cad67df56f6f25b39c7d3981e55b12764` from [PR #37](https://github.com/AdamRoch/OrbitFlow/pull/37). Domain ownership is verified and the certificate is valid. The original application remains available at its fallback URL below.

The studio requires operator Basic authentication. Local credentials are in `.local/deployment/operator.json` (private, ignored); do not commit or share that file. Chrome is signed in at the final studio URL. The Railway-generated address `https://studio-production-5683.up.railway.app` is retained, but the application accepts only the canonical studio host. Use the custom domain for studio/API access.

The provider and v2 Telegram bot are enabled. The original $10 provider authorization has $3.65234270 remaining after local spending and the $0.21005385 cloud smoke run. Cloud application budget is $3.86239655 and its recorded spending starts with that smoke run; do not reset the allowance or interpret the new provider key's larger limit as additional authorization.

For Adam's production test: open the studio, choose **Build an application**, submit a request, inspect the retained messages/source/preview, and approve the exact revision. Then message `@adam_orbitflow_v2_0906_bot` with `/improve` and the requested change. The completed cloud checklist is also available as an initial approved application. Full cloud Telegram interaction and Adam's acceptance are still to be tested. See [deployment evidence](cloud-deployment-evidence.md) for the checks already performed.

Railway project OrbitFlow-v2: 6c6ff377-fcca-4be0-a829-214d911543af. Production environment: 5574c71b-f1e1-459e-9419-4713925b428f. Studio service: 83738887-f965-493b-99d0-bb2d4f8585e7. PostgreSQL is new and isolated.

Required studio settings: PUBLIC_ORIGIN, PREVIEW_BASE_DOMAIN, ORBITFLOW_OPERATOR_USERNAME, ORBITFLOW_OPERATOR_PASSWORD, DATABASE_URL, ORBITFLOW_RUNTIME_TRANSPORT=railway, RAILWAY_TOKEN (project/environment scoped), RAILWAY_ENVIRONMENT_ID, ORBITFLOW_SANDBOX_CHECKPOINT, selected provider credentials, and ORBITFLOW_PROVIDER_BUDGET_USD. Use PORT=4310 and PREVIEW_PORT=4312. Telegram additionally needs the existing v2 token/chat configuration after its local consumer is stopped.

Build the trusted runner with `npx esbuild src/server/runtime-runner.ts --bundle --platform=node --format=esm --packages=bundle --external:railway --outfile=.local/deployment/runtime-runner.mjs`. Stage it as `/opt/orbitflow/runtime-runner.mjs` in a clean Railway Sandbox, build `runtime/Dockerfile` there as `orbitflow-runtime:1.18.29`, and create a named checkpoint before any provider credential is added. Every execution uses a new isolated Sandbox and destroys it afterward. Never checkpoint a sandbox used for a provider turn.

The deployment source is [AdamRoch/OrbitFlow](https://github.com/AdamRoch/OrbitFlow), branch `main`, repository root, using the existing `Dockerfile` and `railway.json`. Automatic deployments and Railway's Wait for CI are enabled. GitHub Actions runs only dependency installation, typecheck, and build; testing stays local. Service settings explicitly configure `/healthz`, a 120-second timeout, one replica, and up to three restarts on failure. For each release, verify the GitHub commit SHA in the successful Railway deployment and check health plus the affected UI. See [ADR 0004](../ADR/0004-github-deployment-source.md).

The first GitHub deployment passed live authentication, catalog, desktop/mobile dropdown, exact model ID, and price-sorting checks. Existing agents, runs, provider budget, and spending were unchanged. These checks made no model calls or saved configuration changes; they do not replace Adam's production walkthrough.

For explicitly authorized recovery, the direct upload command remains `railway up --detach --project 6c6ff377-fcca-4be0-a829-214d911543af --environment 5574c71b-f1e1-459e-9419-4713925b428f --service 83738887-f965-493b-99d0-bb2d4f8585e7`. An accepted upload is not a successful deployment. The `orbitflow-v1-before-v2` Git tag preserves the original repository's main; it is not a rollback artifact for the v2 database.

Deployment checks cover authentication, rejected foreign origins, actual remote provider build/review/approval, retained preview data after reload and revision, pre-provider cancellation, and exact sandbox teardown. The wildcard preview domain targets port4312 and studio domain port4310. Real Telegram improvement is part of Adam's pending production walkthrough. Original DNS records are retained in `.local/deployment/dns-before-cutover.json` for rollback.

Rollback target: old Railway project 4f5a32f8-9e9d-448e-9762-06552d8b8825, app service 00469099-9a6b-4b92-a074-d3bf1ad69f57, fallback https://app-production-0a1f.up.railway.app . Keep its database and deployment intact. A rollback reassigns the custom domain and restores its prior DNS records; it does not copy v2 data into the old database.

Adam's walkthrough is final acceptance. Cloud build success, isolated automated checks, real provider execution, and client-demo readiness are separate claims.

Wildcard DNS records supplied by Railway and added in Cloudflare on September 16, 2026. Public DNS resolves, Railway confirms ownership, and the wildcard certificate is VALID/COMPLETE:

| Type | Name in adamroch.com | Value |
| --- | --- | --- |
| CNAME | *.preview.orbitflow | k0i0aaa1.up.railway.app |
| CNAME | _acme-challenge.preview.orbitflow | k0i0aaa1.authorize.railwaydns.net |
| TXT | _railway-verify.preview.orbitflow | railway-verify=992842ef801cd6cda3a414d3ca2b3c74c4ed712a38b40b90146c7cfc6ff38a2e |

Use DNS-only for these preview CNAME records. The studio CNAME is now `orbitflow` → `nh1w74ki.up.railway.app` with Cloudflare proxy enabled. Its `_railway-verify.orbitflow` TXT is `railway-verify=cbedf01a27ef576c928c6d3e88b0f76ccf75e2c5459c70c51e782de4984365b0`. Railway may show the proxied CNAME as unobserved despite successful verified HTTPS routing; final-domain HTTP and browser checks establish the serving application.
