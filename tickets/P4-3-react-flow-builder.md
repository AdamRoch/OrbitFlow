# P4-3 React Flow workflow builder with node config

**Phase:** 4 · **Tag:** [MUST] · **Depends:** P1-4, P4-1

Visual graph builder (PRD §7): create/edit nodes (agent + node config) and edges (conditions over structured output), save as workflow. Feedback loops must be drawable, not hardcoded.

## Node config panel (each a surfaced dimension)

- entry node flag + channel binding
- fan-out: over open tickets, max N concurrent workers
- plan mode: off | allowed | required — with guidance tooltip ("cheaper model → require planning")
- may_answer_questions: bool
- question escalation target: agent | human-via-channel | human-via-UI
- approval gate: pause before/after node [MUST]

## Acceptance criteria

- [ ] Draw a graph with a cycle (rejection loop), set an edge condition like `verdict == "rejected"`, save, reload — identical.
- [ ] Saved graph JSON is exactly what the engine (P2-2) executes — no translation layer.
- [ ] All node config fields editable with tooltips where the PRD calls for guidance.
