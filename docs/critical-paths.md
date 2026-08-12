# FACT-26 critical paths

Run the five PRD §11 paths together:

```sh
npm run fact26:proof
```

The command creates one clean local PostgreSQL container, removes it on exit, and reports exactly five named subtests:

1. Agent CRUD through the public route handlers and persisted PostgreSQL rows.
2. Rejection-loop graph evaluation and bounded fan-out through the `RuntimeAdapter` mock seam.
3. Durable producer, message bus, engine dispatch, and OpenClaw engine adapter prompt composition through the fake OpenClaw command boundary.
4. Telegram inbound mapping into one channel-triggered run through the Telegram adapter boundary.
5. Exact run cost ceiling pause through the real guardrail transition.

The suite explicitly unsets and checks OpenRouter and Telegram credentials. It never starts OpenClaw, grammY long-polling, or a paid provider call; its only doubles are the documented runtime and Telegram adapter boundaries.
