## Lean implementation rule

  This section overrides every testing and proof instruction elsewhere in this file unless Adam
  explicitly requests that work in the current prompt.

  - Make only the smallest direct code change required for the requested behavior.
  - Prefer deletion. When deletion and addition preserve the same behavior, delete code.
  - Do not add, edit, repair, or run automated tests, proof scripts, fixtures, fake providers,
  audits, lint, typecheck, CI checks, or broad builds unless Adam explicitly requests the exact
  work.
  - Do not investigate failures from existing tests. Report the failure in one sentence and stop.
  - Do not inspect adjacent systems, search for additional problems, refactor unrelated code,
  update documentation, or create tickets unless requested.
  - Do not add abstractions, compatibility layers, fallback paths, extra validation, or
  speculative hardening.
  - Use evidence from Adam's latest end-to-end run. Fix only the smallest code path directly
  implicated by that evidence.
  - Once the requested functionality is written, stop editing. Provide a short manual end-to-end
  runbook and leave the repository.
  - Adam's human-run end-to-end test is the source of truth. Synthetic proofs do not replace it.
  - Never deploy, spend provider credit, push, merge, delete data, or modify production unless
  Adam explicitly authorizes that action.
