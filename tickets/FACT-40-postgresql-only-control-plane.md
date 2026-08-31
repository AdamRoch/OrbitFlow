# FACT-40 Delete the SQLite tracker and use Monitoring as the ticket board

**Priority:** High  
**Depends on:** None

## Outcome

OrbitFlow has one ticket read surface and one ticket database. The existing,
run filtered Monitoring board reads PostgreSQL. The inherited tracker, its
SQLite runtime, and its human mutation paths are gone.

This ticket is mostly deletion. Do not port the inherited tracker to PostgreSQL
and do not add a repository abstraction.

## Scope

* Redirect `/` to `/monitoring?tab=board` and keep Monitoring as the canonical
  run scoped board.
* Delete the inherited list, frontier, detail, new ticket, and label pages.
* Delete issue and label route handlers, server actions, mutation forms, claim
  controls, and board-only components.
* Delete the inherited SQLite domain, serialization, identifier, configuration,
  and test harness code once no surviving caller needs it.
* Move only the small shared status and priority vocabulary that surviving code
  still uses.
* Remove `better-sqlite3`, its types, Drizzle, SQLite environment variables,
  data directories, Compose volumes, entrypoint setup, and build workarounds.
* Add a forward-only PostgreSQL migration that removes `labels` and
  `ticket_labels`. Do not edit old migrations.
* Keep ticket IDs and numbers as strings outside PostgreSQL.

## Ownership boundary

This ticket owns pages, route handlers, inherited tracker components and
libraries, package and deployment cleanup, and the label removal migration. It
does not change workflow dispatch or add platform commands.

## Acceptance criteria

* [ ] The root route opens the Monitoring Board tab.
* [ ] Monitoring can filter tickets by workflow run and has no ticket mutation
      controls.
* [ ] No inherited issue, label, frontier, claim, or blocker API remains.
* [ ] No runtime, package, configuration, deployment, or active test path opens
      SQLite.
* [ ] Clean install and upgrade migrations contain no label tables.
* [ ] Credentialless application tests and the production build pass.

## Verification

Run the focused application tests, migration proof, package audit, and
production build. Record the exact commands in the commit or ticket result.
