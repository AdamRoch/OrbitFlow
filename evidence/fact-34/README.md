# FACT-34 retained evidence

The funded runs used the exact model `openrouter/moonshotai/kimi-k3` from the
executable commit `4b9f7a485ed955fba4fa9a757fc2b728f91662fe`. Automatic malformed-output
retry was disabled. Each numbered directory is one authorized attempt; neither
attempt was rerun.

## Funded outcomes

| Attempt | Result | Run tokens | Run cost | Furthest verified beat |
| --- | --- | ---: | ---: | --- |
| 1 | Failed: strict JSON validation | 43,090 | $0.09507060 | Durable worker question and correlated local Telegram answer |
| 2 | Failed: strict JSON validation | 116,785 | $0.07148640 | Resumed first-pass implementation completed; tester response was not strict JSON |

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
