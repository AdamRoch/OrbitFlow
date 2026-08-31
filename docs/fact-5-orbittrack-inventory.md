# FACT-5 OrbitTrack foundation inventory

OrbitFactory's ticket foundation is adapted from
[OrbitTrack](https://github.com/AdamRoch/OrbitTrack) at exact commit
`589e04165a0744be10b7fc1b05984c6a3bff234c`. The original MIT license remains
in `LICENSE`. Existing OrbitFlow Phase 0 proof packages were retained without
replacement.

## Historical foundation

| Slice | Routes and code | PRD reason |
| --- | --- | --- |
| Ticket board | Monitoring Board, run filter, PostgreSQL reads, stream wakeups | The Board is the live run view. |
| Ticket workflow | Platform tools and workflow engine | Agents create tickets and the engine assigns ready work. |
| Blockers | `set_ticket_dependencies` | Same-run PostgreSQL edges drive frontier eligibility. |

## Deleted

| Removed slice | Deleted routes and code | Ownership or reason |
| --- | --- | --- |
| Inherited tracker | Root board, issue CRUD, labels, claim, old database repository and tests | FACT-40 removed duplicate ticket authority. |
| Dependency map | `/map`, React Flow graph component, graph layout helper, `@xyflow/react`, `@dagrejs/dagre`, map smoke coverage | The map duplicates ticket dependency data and is not the workflow builder specified by P4-3. |
| OrbitTrack Q&A | `/api/questions`, issue question and response routes, transcript component, question schema/domain code, Q&A tests | P5-2 owns questions through the message bus and workflow engine, not OrbitTrack's separate issue Q&A model. |
| Multi-project management | `/api/projects`, project switcher, project creation popover, project CRUD domain code and tests | OrbitFactory is the application scope. FACT-5 needs one internal identifier scope, not user-facing project administration. |
| Bundled tracker skills and upstream planning docs | OrbitTrack `skills/`, `PRD.md`, `VISION.md`, `CONTEXT.md`, `TEST-LATER.md`, and README | OrbitFlow's PRD, tickets, proofs, and later P5-5 README are authoritative. |
| Unused starter assets | Default Next.js public SVGs | No retained route or component referenced them. |

## Deferred without placeholder code

FACT-6 owns the PostgreSQL schema. Later tickets own the engine, runtime,
Telegram, workflow builder, monitoring, schedules, and guardrails. This ticket
does not add dormant routes, tables, navigation, or components for those
features.
