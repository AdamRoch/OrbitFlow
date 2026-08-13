# FACT-31 delivery evidence

This directory separates the current main baseline from the final integrated head and the single authorized provider run.

## Provenance

| Boundary | Commit |
| --- | --- |
| Current main baseline | `b37be8d2f9bd0904e0d97595b85b810f6f34c81a` |
| Preserved source commit | `b023dcbcc48c557e1425eafbc41b413f48b6e7ea` |
| Preserved patch ID | `3f4dcc21f4b26767a4d96a3730aa986ef90e54ec` |
| Final integrated head | `83cb16b274510529817394f023203e0c16566948` |

## Current main baseline

`current-main-b37be8d/` contains the combined post FACT-32 and FACT-33 baseline. It passed the full test suite, typecheck, lint, production build, production dependency audit, Gitleaks, diff check, FACT-6, FACT-7, FACT-9, FACT-10, FACT-11, FACT-16, FACT-17, FACT-18, FACT-24, FACT-25, FACT-26, and the FACT-32 Telegram Compose proof.

## Final deterministic proof

`final-83cb16b/` contains the exact head gate. It passed the full test suite, separately recorded phase zero and coding adapter suites, typecheck, lint, production build, production dependency audit, full branch history Gitleaks, diff check, every predecessor proof listed above, the FACT-32 regression proof, and the focused FACT-31 Compose proof.

`fact31-evidence-trace.log` retains the asserted database snapshots. Readiness was `workflowEngine: operational`. The manual run produced one completed run, one completed dispatch, one runtime invocation, one materialized ticket, and zero pending messages. The duplicate manual schedule trigger returned the original run and message. After the scheduled run there were two completed runs, two completed dispatches, two invocations, one schedule tick, and zero pending messages. Both restart comparisons were unchanged. Project scoped cleanup removed its containers, network, volumes, and images.

## Single provider proof

`provider-kimi-k3-83cb16b/` contains the only paid attempt authorized for this delivery. `provider-proof.log` binds it to final head `83cb16b274510529817394f023203e0c16566948`, attempt 1 of 1, and model `openrouter/moonshotai/kimi-k3`.

The unchanged strict FACT-14 gate completed one Software Factory run with one done ticket, five completed dispatches, five handoffs, 130,033 attributed tokens, and $0.03282840 attributed cost. `structured/proof-result.json` retains the PostgreSQL result. Direct validation confirmed a positive token and cost event for the Kimi K3 implementer, no unexpected OpenRouter model, no database URL or password, and no API key. `artifact/hello.txt` is the retained 38 byte output with SHA-256 `6d161bfb1ff688bcf940e5d18114e8d76a393bba2017eb8c7fce09ee612f2629` and no trailing newline.

The generated coding workspace is intentionally ignored because it contains an internal nested Git repository. The byte exact output and structured workflow evidence are retained separately.

## Review

The fixed diff `origin/main...HEAD` received separate Standards and Spec reviews. Standards found no violation or actionable smell. Spec found no production path gap. Its concern about the FACT-14 prompt wording was reconciled against the preserved patch: the wording clarifies an existing byte exact assertion and was not changed during primary integration or provider execution.

`sha256sums.txt` covers every retained file in this directory except itself and the ignored generated workspace.
