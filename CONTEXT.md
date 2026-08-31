# Domain model

ADR `ADR/0001-postgresql-ticket-authority.md` defines the accepted ticket model.

* **Ticket:** The unit of work stored in PostgreSQL. It has a stable `FACT-N`
  identifier, status, priority, workflow run, optional assignee, and dependency
  edges. Database `BIGINT` values stay strings in TypeScript and JSON.
* **Board:** The read-only, run filtered Board tab in Monitoring. The root route
  redirects to it. There is no separate tracker or human mutation surface.
* **Frontier:** `todo` tickets whose blockers are all `done`.
* **Assignment:** The workflow engine transaction that verifies readiness,
  creates the first dispatch, moves the ticket to `in_progress`, and records its
  assignee.
* **Dependency:** A same-run, same-project edge managed as a complete blocker set
  through `set_ticket_dependencies`. Graph changes and first assignment lock the
  same workflow run so they cannot act on stale state.
* **Labels:** Not part of the OrbitFlow ticket model.
