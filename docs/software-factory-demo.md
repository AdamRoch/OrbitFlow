# Software Factory deterministic demo task

FACT-34 defines one small, legitimate coding task for the real provider demo.
The task uses the ordinary Software Factory template, durable messages, ticket
state, coding adapter, tester verdict, and Telegram reply correlation.

## Task to send

Build a dependency-free Node.js greeting CLI in `greeter.mjs` with tests in
`greeter.test.mjs`.

The final behavior is:

1. `node greeter.mjs --name Ada` writes `Hello, Ada!` and a newline to stdout.
2. `node greeter.mjs --name Ada --shout` writes `HELLO, ADA!` and a newline.
3. Missing `--name`, an empty name, or an unknown option writes a useful message
   to stderr and exits with status 2.
4. The implementation uses only Node.js built-ins and passes
   `node --test greeter.test.mjs`.

Before changing the workspace, the implementer must ask this ticket-thread
question: `Should --name preserve surrounding whitespace or trim it?`
The demo answer is: `Trim surrounding whitespace.` The answer must arrive as a
Telegram reply to the outbound question message.

## Documented review beat

The first implementation pass handles the default greeting and invalid input,
but deliberately leaves `--shout` unsupported. Its handoff must say that the
`--shout` criterion remains incomplete. This is the documented acceptance miss.

The tester must inspect the workspace and run the acceptance commands. Because
`--shout` is absent, the tester must return `artifact.verdict` as `rejected`,
name the observed miss, and put the ticket back in `todo`. The ordinary graph
edge then routes that ticket to the implementer again.

The correction turn adds `--shout`, retains whitespace trimming from the human
answer, and runs the tests. The tester repeats its independent checks and may
return `artifact.verdict` as `approved` only when every final behavior passes.

## Provider output contract

A worker question is a fixed runtime output, not an intake clarification and
not a proof-only database write:

```json
{
  "artifact": {},
  "handoff_brief": "Waiting for the required naming decision.",
  "events": [
    {
      "type": "question",
      "question": "Should --name preserve surrounding whitespace or trim it?"
    }
  ]
}
```

The production engine adapter writes that event as an ordinary `question`
message. `workflow_questions` correlates the ticket thread. Telegram delivery
creates an ordinary `channel_outbound` message, and the explicit Telegram reply
creates an ordinary `answer` message. No demo-only state transition is allowed.
