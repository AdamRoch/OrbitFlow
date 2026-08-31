# ADR 0001: Make PostgreSQL the only ticket authority

**Status:** Accepted
**Date:** 2026-08-31
**Implementation:** `FACT-40`, `FACT-41`, and `FACT-42`

## Context

OrbitFlow has two ticket models. The inherited board stores issues, labels, and
dependencies in SQLite. The workflow engine, monitoring dashboard, and agent
tools store execution tickets in PostgreSQL.

Keeping both models creates duplicate identifiers, write paths, tests,
configuration, and event delivery. Porting the whole inherited tracker to
PostgreSQL would remove one database while preserving most of that accidental
complexity.

## Decision

PostgreSQL is the only ticket database.

The run filtered Board tab in Monitoring is the canonical ticket view. The root
route redirects there. OrbitFlow does not keep a second archive board, ticket
editor, label manager, claim page, or ticket mutation REST API.

Agents write tickets through the platform tool surface. Humans inspect tickets
through Monitoring. Labels are removed because they do not affect workflow
execution.

Dependencies remain because they decide whether work is ready. One
`set_ticket_dependencies` command replaces a ticket's complete blocker set. The
blocked ticket and every blocker must belong to the calling workflow run and the
same project. The command is idempotent, rejects cycles, and cannot change a
ticket after work starts.

Dependency replacement and first assignment serialize on the workflow run. They
do not lock the whole project. Separate runs can plan and dispatch concurrently.

The workflow engine owns assignment. In one PostgreSQL transaction it verifies
that a `todo` ticket is ready, creates its first dispatch, moves it to
`in_progress`, and records the assignee. A lost race leaves no orphan dispatch.

The existing PostgreSQL ticket notification wakes the browser stream. The
browser then refetches authoritative state. The notification is not another
database.

Before deployment removes the old SQLite runtime, a read-only preflight must
inspect the deployed database. Empty issue and dependency tables permit the
cutover without an importer. Any retained work stops the cutover until Adam
chooses to import, archive, or discard it.

Readiness checks must verify the exact required migration head, not only that
PostgreSQL answers a query.

## Why this shape

One authority removes stale reads and conflicting ownership rules.

Reusing Monitoring deletes more code than rebuilding the inherited board. It
also matches the product model: tickets belong to a workflow run, and the demo
operator watches one run at a time.

The run lock protects the graph and assignment boundary while allowing unrelated
runs to proceed. This is the useful scaling boundary for a software factory.

One complete-set dependency command is smaller than separate edge creation and
deletion commands. It also gives retries one clear result.

## Consequences

The inherited tracker pages, mutation routes, forms, domain layer, SQLite test
harness, packages, configuration, and deployment volume are deleted.

PostgreSQL availability and the exact schema version are required before the app
is ready.

Ticket identifiers and PostgreSQL `BIGINT` values remain strings at TypeScript
and JSON boundaries.

There is no repository interface, dialect switch, or compatibility adapter.
OrbitFlow has one implementation for one database.

## Rejected alternatives

### Port the complete tracker to PostgreSQL

Rejected because it retains duplicate board behavior, human mutation paths,
labels, and most of the old tests.

### Keep both databases behind a repository interface

Rejected because a permanent abstraction does not solve the duplicate authority.

### Lock the whole project

Rejected because independent workflow runs should not block one another.

### Add a separate claim command

Rejected because workflow dispatch already decides who receives work. A second
claim path creates competing ownership rules.

### Assume the deployed SQLite database is disposable

Rejected because local emptiness is not evidence about deployed state. The
cutover must inspect the deployed database before removing it.
