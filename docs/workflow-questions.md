# Durable workflow questions and approvals

FACT-24 uses the existing message bus and workflow engine for questions,
answers, and approval gates. `workflow_questions` is the correlation record; it
does not replace the `messages` trail. Every question and answer remains a
normal retained bus message attached to the originating run and ticket.

A worker `question` completes its current dispatch turn and pauses only its
`workflow_thread_states` row. The correlated approving or answering message
changes that same row back to running and creates exactly one continuation for
the originating node. Fan-out siblings use different thread rows and continue.

The node snapshot selects one accepted route:

* `agent` creates a normal durable dispatch to the configured agent only when a
  node for that agent has `may_answer_questions: true`.
* `human-via-channel` creates a normal Telegram outbound message. Telegram's
  explicit reply identifier correlates the inbound update to the question.
* `human-via-UI` exposes the pending row in the monitoring Board and accepts an
  answer through `POST /api/questions/:id/answer`.

Before and after gates create `approval` questions through the same path. A
non-approving answer remains visible in Trail but does not close the question
or resume the thread. PostgreSQL locks and the question's single durable answer
link make duplicate delivery and process restart safe.

Run the disposable proof with:

```sh
npm run fact24:proof
```

It covers sibling fan-out progress, all three routes, both approval boundaries,
Trail history, duplicate answers, and restart-safe exact-thread resumption.
