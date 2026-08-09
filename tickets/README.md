# OrbitFactory tickets

Decomposed from `orbitflow-prd.md`. One file per ticket, named `P<phase>-<n>-slug.md`.
Tags: [MUST] spec must-have · [CORE] demo narrative · [STRETCH] Phase 6 only.

## Order and gates

- **Phase 0 is a gate.** If P0-1..P0-3 don't all prove out, revise the architecture in the PRD before starting Phase 1. P0-4 (Yuno email) goes out before any more code is written.
- **P2-6 is a gate.** No Phase 3+ work until a full Software Factory run completes end to end.
- Phases are sequential; tickets within a phase are mostly parallel unless `Depends` says otherwise.
- Phase 6 is quarantined: only touched after Phase 5 is done.

## Index

| Ticket | Title | Tag |
|---|---|---|
| P0-1 | Spike: programmatic OpenClaw control | MUST |
| P0-2 | Spike: platform CLI tool callable from an OpenClaw agent | MUST |
| P0-3 | Spike: headless coding CLI wrapper → pick v1 CodingToolAdapter | CORE |
| P0-4 | Send Yuno clarification email | MUST |
| P1-1 | Fork OrbitTrack and strip unused features | MUST |
| P1-2 | Postgres schema and migrations | MUST |
| P1-3 | Docker Compose single-command run | MUST |
| P1-4 | CRUD API: agents, skills, workflows | MUST |
| P2-1 | Message bus | MUST |
| P2-2 | Workflow engine: graph evaluation and dispatch | MUST |
| P2-3 | OpenClaw RuntimeAdapter | MUST |
| P2-4 | CodingToolAdapter v1 | CORE |
| P2-5 | Platform tool surface for agents | MUST |
| P2-6 | E2E gate: Software Factory run completes | MUST |
| P3-1 | Telegram bot integration | MUST |
| P3-2 | Orchestrator intake → run spec → run kickoff | MUST |
| P3-3 | Status queries and final report via Telegram | MUST |
| P4-1 | WebSocket state stream | MUST |
| P4-2 | Agent editor UI | MUST |
| P4-3 | React Flow workflow builder with node config | MUST |
| P4-4 | Ship two workflow templates | MUST |
| P4-5 | Monitoring tabs: board, trail, agents, cost | MUST |
| P5-1 | Guardrails enforcement | MUST |
| P5-2 | Question/answer flow, escalation, approval gates | MUST |
| P5-3 | Scheduling and daily standup | MUST |
| P5-4 | Critical-path tests | MUST |
| P5-5 | README and architecture diagram | MUST |
| P5-6 | Record the demo | CORE |
| P6-1 | Stretch backlog | STRETCH |
