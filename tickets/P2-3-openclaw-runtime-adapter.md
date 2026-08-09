# P2-3 OpenClaw RuntimeAdapter

**Phase:** 2 · **Tag:** [MUST] · **Depends:** P0-1 findings, P1-4

Productionize the P0-1 spike into the `RuntimeAdapter` (PRD §5): create/update an OpenClaw agent from an `agents` row, wake with a composed prompt, capture structured output + events + token usage into `cost_events`, detect completion, terminate.

## Scope

- **Prompt composition** at delivery time: node system prompt + workflow/run context + assigned ticket(s) + upstream `handoff_brief` + agent memory + output-format contract.
- **Output contract:** every turn must emit `{artifact, handoff_brief, events[]}`. Validate; on malformed output retry once, then emit a `system` error message to the bus.
- **Wake timeout:** a configurable per-node timeout (sane default, e.g. minutes not hours). On timeout: terminate the OpenClaw session, emit a `system` error message, engine treats it like a failed turn. A hung agent must never freeze a run silently.
- **Memory [MUST]:** canonical per-agent memory lives in the platform DB; sync into OpenClaw's memory files on wake. Facts survive across runs.

## Acceptance criteria

- [ ] Agent row → live OpenClaw agent, updated on edit.
- [ ] Wake → structured output captured, token usage lands in `cost_events`.
- [ ] Malformed output: one retry, then `system` error message on the bus.
- [ ] Hung wake: timeout fires, session terminated, run surfaces the error instead of stalling.
- [ ] A fact stored in run 1 is present in the composed prompt of run 2.
