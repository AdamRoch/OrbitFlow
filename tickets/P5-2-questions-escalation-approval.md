# P5-2 Question/answer flow, escalation, approval gates

**Phase:** 5 · **Tag:** [MUST] · **Depends:** P2-2, P3-1, P4-3

One mechanism covers Q&A, approval gates, and mid-run Telegram interaction (PRD §7): agent posts `type: question` on its ticket → engine pauses **that thread only** → routes per the node's escalation config (agent | human-via-channel | human-via-UI) → `answer` message resumes it.

## Scope

- Escalation to another agent: target agent is woken with the question (respecting its `may_answer_questions`).
- Human-via-channel: question lands in Telegram; reply becomes the `answer`.
- Human-via-UI: question surfaced in UI with an answer box.
- Approval gates: implemented as an auto-generated question before/after a gated node.

## Acceptance criteria

- [ ] While one worker waits on a question, sibling fan-out workers keep running.
- [ ] Each escalation target works end to end; answering from Telegram resumes the thread (demo beat, PRD §12 step 4).
- [ ] Approval gate pauses the run at the configured point and resumes on approve.
- [ ] Full Q&A trail visible on the ticket and in the Trail tab.
