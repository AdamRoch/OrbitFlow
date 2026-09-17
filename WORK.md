# OrbitFlow v2 delivery

Current repository: `/Users/adam/orbitflow-v2`. Original `/Users/adam/orbitflow` remains read-only. Local product and recorded Telegram demo completed September 6 at 6d00116; deployment implementation at 0237c4c.

## Current slice: Workflow clarity, September 17

Workflow nodes and the workflow list now show assigned agents and models. The editor opens with the first step selected and keeps its assignment, exact model ID, effective tools, approval rule, and expandable instructions beside the graph. Agents can be reassigned or edited directly; agent saves apply to shared configurations while workflow drafts survive the round trip. Adding agents uses a compact selector. Existing outcome routes and terminal settings remain editable.

A Telegram panel identifies the configured bot, provides the saved workflow's build/improve command template, and explains ordinary conversation versus a pending improvement request. New or unsaved workflows cannot copy a misleading command. Improve templates require an explicit approved source run. Bot configuration is labeled as configuration, not delivery proof. No backend routing or execution behavior changed.

Authorized local checks passed: typecheck, production build, nine Chromium browser scenarios, and three focused existing Telegram parser/guided-selection/allowlist tests. Browser checks used representative configurations, schema-validated in-memory saves, and the real command parser; they covered agent reassignment, shared-agent edits, save failure/cancel, draft preservation, new workflows and removal, command identity and configuration states, keyboard/focus controls, touch dragging, existing distant nodes, and 390px/1024px layouts. Desktop/mobile screenshots were visually reviewed. Evidence and temporary checks: `.local/workflow-clarity/`. No new dependency or permanent test file; `tests/models.test.ts` stays absent. These checks do not establish real bot delivery or model-backed execution.

Prepared on `codex/workflow-clarity` at `f201787`; Adam approved the preview and deployment September 17. Release through the existing GitHub pull request, minimal CI, and Railway auto-deploy flow. Verify the exact merge commit, health, live editor, and unchanged configurations/spending. Release evidence is retained in `.local/workflow-clarity/release.json` after verification. No provider turn or Telegram message is part of this release; real cloud Telegram delivery remains separate acceptance work.

## Previous slice: Model dates and coding scores, September 17

Added the OpenRouter listing month/full-date tooltip, Artificial Analysis Coding Index, newest/highest-score sorting, and selected-model benchmark links. Missing metadata stays explicit; zero remains a valid score. The listing date is labeled **Added**, not presented as a verified release date. Uses the existing public catalog request/cache with no new API credentials or dependencies. Decision: `ADR/0003-live-model-suggestions.md`.

Local typecheck/build and metadata boundary checks passed. Six browser scenarios passed with the built UI, live catalog, in-memory agent editing, and labeled edge-case fixtures: family variants, sorting/selection/exact IDs, existing-model preservation, missing/zero scores and UTC month boundaries, stale metadata, and the 390px layout/manual entry. The live snapshot had 280 eligible models and 134 coding scores. Evidence and desktop/mobile screenshots: `.local/model-metadata/`. No permanent test file was added; `tests/models.test.ts` remains absent.

Prepared on `codex/model-dates-benchmarks` at `d58b1c6`; Adam approved deployment September 17. Publish through the existing GitHub/CI/Railway flow, verify the exact deployed merge commit, and inspect the live picker without saving configurations or making provider calls. Release state, before/after comparisons, and live browser evidence are retained in `.local/model-metadata/`; use `release.json` for the verified commit and deployment result. Adam's production walkthrough and real cloud Telegram improvement remain separate acceptance work.

## Completed slice: GitHub deployment source, September 17

Published `orbitflow-v2` and merged [PR #37](https://github.com/AdamRoch/OrbitFlow/pull/37) into `main` at `97618b2cad67df56f6f25b39c7d3981e55b12764`. The original main is preserved by `orbitflow-v1-before-v2`; separate local rebuild history remains on `codex/local-v2-history`. Original deployment and production data remain intact. Decision: `ADR/0004-github-deployment-source.md`.

The existing OrbitFlow-v2 studio now follows GitHub `main`, with automatic deployments and Wait for CI enabled. CI has one dependency-install/typecheck/build job and no tests or provider credentials. Local install/typecheck/build passed; PR and main CI passed. Railway deployment `a6e749fb-10bd-4bd9-baa1-48763e33396c` succeeded with that exact merge commit. The subsequent handoff merge triggered deployment `38f47281-910f-4f4e-a7bc-72e3467f5ad3`, observed WAITING until CI passed.

Enabling Railway's deployment healthcheck gate exposed a deadlock: the new executor exits while the old executor owns the database lock, and Railway retains the old process until the new one is healthy. Leave that gate unset, retain one replica and the standard ten failure restarts, and check `/healthz` after rollout. The executor lock is unchanged. This accepts a brief deployment interruption, consistent with the single-operator demo boundary; check active runs before merging. See ADR 0004 and the production runbook. No application code or tests were changed for this configuration correction.

Live read-only verification passed: public health200, anonymous studio/catalog401, authenticated fresh catalog with 280 models, search/keyboard selection/exact ID/prices/sorting, desktop and 390px layout. Screenshots were visually reviewed. All nine agents, existing runs, provider budget, and recorded spending were unchanged; no model calls or configuration saves. Evidence: `.local/deployment/github-verification.json` and `github-picker-*.png`. A blocked Cloudflare analytics POST was excluded from the application-write check.

Final release evidence is retained in `.local/deployment/github-state.json` and `github-release.json`; verify its timestamp and exact commit when checking deployment state. Product acceptance remains Adam's production walkthrough, including real cloud Telegram improvement.

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
