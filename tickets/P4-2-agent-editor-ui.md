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
