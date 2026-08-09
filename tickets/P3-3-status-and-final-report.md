# P3-3 Status queries and final report via Telegram

**Phase:** 3 · **Tag:** [MUST] · **Depends:** P3-2

Remaining orchestrator standing duties (PRD §9): answer "how's it going" with real run/ticket state, and text a final report when the run completes.

## Acceptance criteria

- [ ] Status question mid-run gets an answer grounded in current ticket/run state (via `list_tickets` etc., not hallucinated).
- [ ] Run completion triggers an orchestrator wake that sends a final report to the chat.
- [ ] Both flows are ordinary bus messages — observable in the Trail tab.
