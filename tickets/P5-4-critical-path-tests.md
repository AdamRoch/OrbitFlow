# P5-4 Critical-path tests

**Phase:** 5 · **Tag:** [MUST] · **Depends:** the features under test

The five critical paths from PRD §11 — no more, no less:

- [ ] Agent CRUD round-trip (API + persistence).
- [ ] Workflow engine graph evaluation incl. rejection loop and fan-out (mock adapter).
- [ ] Message delivery: producer → bus → engine dispatch → adapter called with composed prompt (mock runtime).
- [ ] Telegram inbound → run created (mock bot API).
- [ ] Guardrail: cost ceiling halts a run.

## Acceptance criteria

- [ ] All five green in one command (runs in CI or at least locally documented).
- [ ] Mocks at the adapter interfaces (§5) — tests must not need OpenClaw, Telegram, or an API key.
