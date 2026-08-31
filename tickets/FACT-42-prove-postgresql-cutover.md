# FACT-42 Prove the PostgreSQL-only cutover and demo data path

**Priority:** High  
**Depends on:** FACT-40, FACT-41

## Outcome

The combined data layer is safe to redeploy and ready for the software factory
demo path. The proof checks real PostgreSQL behavior, schema freshness, restart
behavior, and the absence of any live SQLite path.

## Scope

* Add a read-only deployed SQLite preflight that reports project, issue, and
  dependency counts without changing data.
* Make the cutover runbook stop when the deployed preflight finds retained work.
  Import, archive, or discard requires a separate Adam decision.
* Make application and engine readiness verify the exact required migration
  head, including its checksum, rather than only running `SELECT 1`.
* Consolidate disposable PostgreSQL proof for clean install, upgrade, ticket
  reads, dependency races, atomic assignment, committed stream wakeups, and the
  run filtered Monitoring board.
* Prove the production Compose engine becomes ready and recovers after restart.
* Remove remaining active documentation and scripts that describe SQLite as a
  supported runtime.
* Audit the final repository for SQLite packages, environment variables, paths,
  code imports, and test setup.
* Update `AGENTS.md`, `CONTEXT.md`, and current architecture and runbook docs so
  they point to the final proof commands.

## Ownership boundary

This is the integration gate. It may fix defects exposed by the combined work,
but it should not add a second data abstraction or rebuild deleted tracker
features.

## Acceptance criteria

* [ ] The deployed preflight is read-only and the runbook fails closed on
      nonempty issue or dependency data.
* [ ] Health is unhealthy when PostgreSQL is unreachable or not at the exact
      migration head.
* [ ] One disposable PostgreSQL run proves clean install, upgrade, graph races,
      assignment, stream wakeup, and Monitoring reads.
* [ ] The Compose engine proves readiness and restart recovery.
* [ ] Active code, packages, tests, configuration, and deployment files contain
      no SQLite runtime path.
* [ ] `npm test`, the PostgreSQL proof, the relevant FACT proofs, and
      `npm run build` pass.

## Verification

Publish one command transcript that separates credentialless tests, disposable
PostgreSQL proof, Compose proof, production build, and the deployed preflight
result. Do not call the cutover safe without the deployed result.
