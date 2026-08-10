# P4-2 Agent editor UI

**Phase:** 4 · **Tag:** [MUST] · **Depends:** P1-4

Create/edit/delete agents from the UI with every `agents` field (PRD §6): name, role, system prompt, model, tool access, channel binding, schedules, memory (viewable **and editable** facts), skills, interaction rules, guardrails.

## Notes

- Templates ship with opinionated default system prompts, editable.
- The **contract** (output schema, tool surface, message types) is fixed per node type and must NOT be user-editable — don't render it as a form field.
- Channel binding must be visible per agent [MUST, PRD §9].

## Acceptance criteria

- [ ] Every field round-trips through the UI.
- [ ] Memory facts listed, editable, deletable.
- [ ] Guardrails (cost ceiling, rate limit, blocked actions) editable per agent.
- [ ] Configurability is a judged criterion (20%) — each dimension is discoverable, labeled, and where non-obvious, tooltipped.

## Implementation status

**in_progress** — FACT-19 remains under independent Firstmate review. The
current correction pass merges FACT-9 forward; moves destructive confirmation
into a document-level portal modal, so layout navigation is inert while either
deletion is pending; adds the `/agents` route title for Next.js announcements;
and fixes the 390px roster shrink boundary plus stable form-control identities.
Focused editor/mobile-nav/title tests, inherited non-PostgreSQL tests,
typecheck, lint, production build, audit, and the 390px production-browser
layout check pass. FACT-6/8/9 disposable PostgreSQL proofs passed immediately
before the final DOM-only form-name correction; a subsequent exact-head rerun
was prevented by an unavailable local Docker daemon. Schedule execution and
guardrail enforcement remain deferred to FACT-25. Direct PR review remains
open; Firstmate owns exact-head review, merge, and tracker completion.
