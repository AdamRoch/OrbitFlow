# Railway deployment evidence

Recorded September 16, 2026 (America/Chicago). This is deployment verification; Adam's production walkthrough remains final product acceptance.

## Services and credentials

- Separate Railway project OrbitFlow-v2, production environment, with studio and PostgreSQL. Original application and database are preserved.
- Scoped production project token successfully restored checkpoint `orbitflow-1-18-29-52e6aad812`; trusted runner and OpenCode runtime image were present. Probe sandbox `63cc163d-c8f6-412c-a822-f80da897e556` was destroyed.
- New OpenRouter key validated with initial usage zero. Cloud application allowance is $3.86239655, preserving the earlier $10 total authorization after $6.13760345 local spending. A higher provider-key limit does not increase that authorization.
- Credential configuration deployment `6ddf8621-fa89-448a-ba8d-8d2cd7fe8d5a` succeeded. Native Chrome authenticated to the studio and rendered the configured provider, Telegram, agents, workflows, and live run views.
- Telegram `getMe` succeeded for `adam_orbitflow_v2_0906_bot`. Cloud consumer is configured; local port4310 has no listener. No real cloud Telegram conversation is claimed in this record.

## Real cloud workflow

Run `ed71ef1e-a141-4c05-9aaf-d6608a9dbe58` built OrbitFlow Cloud Check, a persistent browser checklist. Four actual OpenCode turns completed: Builder, Reviewer feedback, Builder revision, and Reviewer approval. The reviewer requested a shorter source implementation; the final source has 109 lines. The runtime used the configured Sonnet 4.6 Builder and GPT-5.4 Reviewer through OpenRouter.

Final revision `09af025e-0b7e-4772-8364-d23610238838` was approved through the exact pending approval token after browser inspection. Run status is completed. Recorded cost $0.21005385 matches the provider key's usage, leaving $3.65234270 of authorized cloud allowance. Durable messages, events, source revisions, model snapshots, and approval remain in the production database. Raw run evidence is retained privately in `.local/deployment/cloud-build-evidence.json`.

Chrome verified adding `Verify cloud persistence`, marking it complete, and retaining it after reload. A separate temporary item was added, deleted, and remained absent after reload. Navigating from the earlier revision to the final reviewed revision on the same application origin preserved the completed item. The application preview returned HTTPS200 with CSP blocking network connections, frames, objects, workers, and form submissions.

## Cancellation and cleanup

A separate provider-free probe used the actual Railway transport and aborted immediately after sandbox creation, before runner execution. Sandbox `860cbc88-1352-44b9-8d33-aa9d3e1a1643` returned `Runtime turn aborted` with zero cost and was destroyed. This proves cancellation before provider execution, not cancellation during an in-flight model request. After the completed workflow, Railway listed no remaining sandboxes.

## Domain cutover

The preview wildcard has propagated DNS, verified ownership, and a valid Railway certificate. Main domain `orbitflow.adamroch.com` was reassigned to v2 port4310, and Cloudflare CNAME/TXT were updated. Canonical-origin deployment `327fb601-b103-43c5-a2fc-3019afd380ae` succeeded. Main-domain ownership is verified and its Railway certificate is VALID/COMPLETE. Cloudflare proxy remains enabled on the studio.

Final-domain checks passed: health200; anonymous studio/API401; authenticated studio/settings/SSE200; rejected foreign-Origin mutation403; preview HTTPS200 with frame-ancestors restricted to the final studio origin. Native Chrome authenticated at the final domain and rendered the completed run, nine agents, two workflows, provider budget/spending, and configured Telegram bot. No sandboxes remained. Machine-readable verification is in ignored `.local/deployment/final-verification.json`.

Original Cloudflare values are saved in ignored `.local/deployment/dns-before-cutover.json`. The original service remains at `https://app-production-0a1f.up.railway.app`; no old database, runtime data, or original bot was migrated or deleted.
