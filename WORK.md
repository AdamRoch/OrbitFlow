# OrbitFlow v2 delivery

Current repository: `/Users/adam/orbitflow-v2`. Original `/Users/adam/orbitflow` remains read-only. Local product and recorded Telegram demo completed September 6 at 6d00116; deployment implementation at 0237c4c.

## Current slice: GitHub deployment source, September 17

Published `orbitflow-v2` and merged [PR #37](https://github.com/AdamRoch/OrbitFlow/pull/37) into `main` at `97618b2cad67df56f6f25b39c7d3981e55b12764`. The original main is preserved by `orbitflow-v1-before-v2`; separate local rebuild history remains on `codex/local-v2-history`. Original deployment and production data remain intact. Decision: `ADR/0004-github-deployment-source.md`.

The existing OrbitFlow-v2 studio now follows GitHub `main`, with automatic deployments and Wait for CI enabled. CI has one dependency-install/typecheck/build job and no tests or provider credentials. Local install/typecheck/build passed; PR and main CI passed. Railway deployment `a6e749fb-10bd-4bd9-baa1-48763e33396c` succeeded with that exact merge commit. Explicit service settings match the repository's `/healthz` check, 120-second timeout, one replica, and three failure restarts.

Live read-only verification passed: public health200, anonymous studio/catalog401, authenticated fresh catalog with 280 models, search/keyboard selection/exact ID/prices/sorting, desktop and 390px layout. Screenshots were visually reviewed. All nine agents, existing runs, provider budget, and recorded spending were unchanged; no model calls or configuration saves. Evidence: `.local/deployment/github-verification.json` and `github-picker-*.png`. A blocked Cloudflare analytics POST was excluded from the application-write check.

Next action: publish this handoff and verify its automatic deployment after CI; retain the final GitHub/Railway state in `.local/deployment/`. Product acceptance remains Adam's production walkthrough, including real cloud Telegram improvement.

## Completed slice: Live model suggestions, September 17

Implemented a searchable agent-model dropdown using the live public OpenRouter catalog, ordered by weekly usage with optional output-price sorting. Suggestions show input/output prices and context, require text/tool support, and exclude batch variants, expired entries, and moving routers. New agents require a selection; existing IDs remain unchanged unless explicitly selected or edited. Manual IDs remain available for all supported providers. Metadata is cached for 30 minutes with refresh and explicit stale/error states. Decision: `ADR/0003-live-model-suggestions.md`.

Authorized checks passed: `npm run typecheck`, `npm run build`, and six temporary focused tests covering catalog filtering, cache/retry behavior, price handling, exact agent/runtime model IDs, and studio authentication. The test file was removed at Adam's request after those checks passed. Seven Chromium browser scenarios passed using the built UI, live catalog, and in-memory agent fixtures: search/keyboard/mouse selection, configuration save, existing-ID preservation, price sorting, empty results, stale/cold outages, manual entry, and 390px layout. Desktop/mobile screenshots and scope-labeled evidence are in `.local/model-picker/`. No production configuration writes, database migration, model/provider turns, push, or deployment.

Adam approved the picker mockup. Deployment and real execution with newly selected models remain separate. Existing production walkthrough and cloud Telegram acceptance below are still pending. Pre-existing README/tutorial work was preserved.

## Previous slice: Railway production test deployment

Adam authorized deployment and domain cutover, confirmed scoped-token creation, and supplied a new OpenRouter key. V2 is live at **https://orbitflow.adamroch.com** in the separate Railway OrbitFlow-v2 project with its own PostgreSQL database. Canonical-origin deployment `327fb601-b103-43c5-a2fc-3019afd380ae` is SUCCESS. Main domain and preview wildcard ownership are verified and certificates VALID/COMPLETE. Cloudflare proxy remains enabled on the studio; preview CNAMEs are DNS-only. Original service/database/bot remain intact; old fallback https://app-production-0a1f.up.railway.app returns200. No Git push.

## Completed behavior and checks

- Scoped production token restored the credential-free runtime checkpoint `orbitflow-1-18-29-52e6aad812`; runner and pinned OpenCode image verified; probe sandbox destroyed.
- Cloud provider, bounded budget, Telegram bot, nine agents, and two editable workflows configured. Local v2 server is stopped. Original bot untouched.
- Actual cloud run `ed71ef1e-a141-4c05-9aaf-d6608a9dbe58` completed four turns: build, review feedback, revision, review approval. Exact revision `09af025e-0b7e-4772-8364-d23610238838` approved after browser inspection.
- Chrome verified checklist add/toggle/delete, reload persistence, and retained data across revisions on the isolated application origin. Native Chrome rendered the authenticated studio at the final production URL with the completed run and configured integrations.
- Final-domain health200; anonymous studio/API401; authenticated settings200. Detailed final access/SSE/preview checks retained in `.local/deployment/final-verification.json`.
- Actual Railway transport cancellation immediately after sandbox creation returned zero usage and destroyed its exact sandbox. This is pre-provider cancellation proof, not an in-flight provider cancellation claim. No sandboxes remained after the workflow.
- Recorded cloud spend $0.21005385 exactly matches new provider-key usage. Cloud allowance $3.86239655 preserves the earlier $10 total authorization after $6.13760345 local spend. Remaining authorized allowance **$3.65234270**. Do not treat the new key's $20 limit as new authorization.
- Prior deployment code checks: typecheck/build passed; public-access/runner framing7/7; focused runtime12/12 with labeled transport stubs. This handoff changed deployment/configuration/docs; those suites were not rerun.

## Handoff and next action

Adam's production walkthrough is next. Telegram `getMe` succeeded and cloud consumer is configured for `adam_orbitflow_v2_0906_bot`; real cloud Telegram conversation/improvement remains for the production test. Local recorded Telegram proof is separate. No code improvement work is started.

Operator login is in ignored `.local/deployment/operator.json`. Credentials and private verification evidence are excluded from Git and source uploads. DNS rollback values are in `.local/deployment/dns-before-cutover.json`. See docs/PRODUCTION.md and docs/cloud-deployment-evidence.md.

## Tutorial handoff, September 16

Created `docs/tutorial/orbitflow-tutorial.pptx`: 18 editable slides covering the cloud studio, build/review/approval, Telegram improvements, configuration, recovery, and local startup. Content follows current code, documentation, and authenticated read-only browser inspection. Package/layout checks passed and all 18 rendered slides were visually reviewed. Speaker notes preserve the pending cloud Telegram acceptance boundary. No provider turns, saved configuration changes, deployment, or push. Production walkthrough remains the next product action.
