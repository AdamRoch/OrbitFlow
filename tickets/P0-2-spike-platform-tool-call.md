# P0-2 Spike: platform CLI tool callable from an OpenClaw agent

**Phase:** 0 · **Tag:** [MUST] · **Depends:** P0-1

Prove the platform tool surface direction (PRD §5): an agent running on OpenClaw can call a custom CLI we provide, and we can capture that call.

## Scope

- Write a stub CLI (e.g. `orbit-tool echo <payload>`).
- Register/expose it to an OpenClaw agent as a tool.
- Wake the agent with a prompt that requires calling it; capture the call and its arguments.

## Acceptance criteria

- [ ] Agent calls the custom tool during its turn without human help.
- [ ] The call and its arguments are captured on the platform side.
- [ ] Findings noted: how tools are registered, any sandboxing/path constraints that affect `create_ticket`/`post_message` later.
