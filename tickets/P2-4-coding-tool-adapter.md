# P2-4 CodingToolAdapter v1

**Phase:** 2 · **Tag:** [CORE] · **Depends:** P0-3 decision

Productionize the P0-3 spike: the chosen coding CLI wrapped as agent tool `delegate_coding_task(task, workspace) -> {diff, log, usage}` (PRD §5). Interface designed for plurality; exactly one implementation ships.

## Notes

- Delegation is a tool call **inside agent judgment**: the implementer agent reviews the returned diff and iterates or accepts. That behavior belongs to the implementer node's prompt/skill, but the adapter must return the diff in a reviewable form to enable it.
- Auth via single env-var API key (evaluator constraint).

## Acceptance criteria

- [ ] Tool callable from an OpenClaw agent; returns `{diff, log, usage}`.
- [ ] Usage from delegated work is attributed to the calling agent's run in `cost_events`.
- [ ] Failure modes (CLI crash, timeout) surface as structured errors, not hangs.
