# FACT-34 retained evidence

The funded runs used the exact model `openrouter/moonshotai/kimi-k3` from the
executable commit `4b9f7a485ed955fba4fa9a757fc2b728f91662fe`. Automatic malformed-output
retry was disabled. Each numbered directory is one authorized attempt; neither
attempt was rerun.

## Funded outcomes

| Attempt | Result | Run tokens | Recorded cost floor | Furthest verified beat |
| --- | --- | ---: | ---: | --- |
| 1 | Failed: strict JSON validation | 43,090 | $0.09507060 | Durable worker question and correlated local Telegram answer |
| 2 | Failed: strict JSON validation | 116,785 | $0.07148640 | Resumed first-pass implementation completed; tester response was not strict JSON |

Tokens and dollars are reported separately because the retained records have
different completeness. The token totals above are the exact durable per-run
totals. Each dollar value is only an incomplete cost floor: OpenClaw retained
the gateway Kimi token rows with `$0.00000000` because that provider path did
not supply cost attribution, while the nested coding-adapter call retained its
nonzero cost. The missing gateway spend cannot be recovered from this evidence,
so neither dollar value is claimed as the complete provider cost.

Both provider runs created exactly one ticket, emitted the exact documented
worker question as an ordinary durable message, produced one pending
`workflow_questions` row, accepted one correlated Telegram reply, and resumed
only that ticket thread. Both then failed closed on a non-JSON final response.
Attempt 1 failed in the resumed implementer dispatch. Attempt 2 completed that
dispatch and produced the intentionally incomplete first-pass files, then failed
in the tester dispatch before a durable rejection verdict existed.

The deterministic PostgreSQL and Compose proofs cover the full required state
machine: question, correlation, restart, first-pass rejection, ticket reopen,
corrected implementation, approval, and final report. The funded evidence does
not claim that Kimi reproduced those later beats.

## Files

Each run retains:

* `provider-proof.log`: attempt identity, executable SHA, progress markers, and
  terminal failure
* `structured/proof-result.json`: durable run, message, question, ticket,
  dispatch, token, and cost rows
* `artifact/`: the generated workspace files present at failure
* `gateway.log`: local OpenClaw gateway diagnostics with credential redaction
* `secret-scan.log`: a clean Gitleaks scan of the retained directory

Internal invocation hashes are shortened in the retained JSON. They are
idempotency identifiers, not credentials, and the shortening prevents generic
secret scanners from misclassifying them as API keys.

## Deterministic proof

The `deterministic/` logs were recorded on retained-evidence commit
`465df1e34eeba7a04bbf4ca68ba5d32fe4a65409`. Every command exited zero:

| Gate | Result |
| --- | --- |
| `npm run typecheck` and `npm run lint` | Passed |
| `npm test` | 168 app tests passed, 14 skipped; 25 phase-zero tests passed; 42 coding-adapter tests passed |
| `npm run build` | Next.js production build passed |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm run fact21:proof` | 4 template clean-install, restart, upgrade, and no-overwrite tests passed |
| `npm run fact24:proof` | 4 durable question, restart, and exact-thread tests passed |
| `npm run fact11:proof` | OpenClaw 2026.4.15 CLI path and 24 production-adapter tests passed |
| `npm run fact31:proof` | Dependency production-engine Compose proof passed |
| `npm run fact34:proof` | Real PostgreSQL test and isolated production-adapter Compose proof passed |

FACT-14's funded provider proof was not run because that would have created an
unauthorized third paid attempt. The two authorized provider attempts above are
the complete funded evidence for this delivery.
