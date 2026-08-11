# FACT-13 platform tool surface

`bin/orbit-agent-tools.mjs` is the production agent CLI. It accepts exactly
four commands and a single JSON argument:

```sh
node bin/orbit-agent-tools.mjs create_ticket '{"agentId":"1","runId":"1","projectId":"1","title":"Investigate queue","idempotencyKey":"turn-12-create-1"}'
node bin/orbit-agent-tools.mjs update_ticket '{"agentId":"1","runId":"1","ticketId":"1","expectedUpdatedAt":"2026-08-10T12:00:00Z","status":"todo","idempotencyKey":"turn-12-update-1"}'
node bin/orbit-agent-tools.mjs post_message '{"agentId":"1","runId":"1","ticketId":"1","recipient":"agent:reviewer","type":"question","payload":{"question":"Should this be split?"},"idempotencyKey":"turn-12-question-1"}'
node bin/orbit-agent-tools.mjs list_tickets '{"agentId":"1","runId":"1","idempotencyKey":"turn-12-list-1"}'
```

The CLI emits one bounded JSON response to stdout and does not require an API
credential. `DATABASE_URL` is its only configuration. Every command requires
an idempotency key and complete agent/run/ticket attribution; ticket creation
derives the new ticket attribution in the same PostgreSQL transaction.

Every CLI invocation enters `dispatchPlatformTool`. That typed dispatcher is the
one future enforcement point for P5-1 blocked-action policy. It validates the
closed input schema before opening a transaction, checks the agent, run, and
ticket ownership directly in PostgreSQL, and uses parameterized SQL only.

`create_ticket` and `update_ticket` append a `system` message. `post_message`
appends the requested message type, including `question`. All use FACT-9's
`insertMessage` producer inside the ticket transaction, so the ticket mutation,
durable message, enqueue, ready projection, and idempotency result commit or
roll back together. `list_tickets` is read-only, scoped to the calling run, and
records its durable idempotent invocation in the same PostgreSQL authority.

Migration `0012-platform-tool-idempotency.sql` is required because a retry after
the agent loses a successful response must replay its first durable result,
rather than making another ticket or message. The key is unique per agent and
run; reusing it for a different request fails closed. FACT-13 developed this
migration as `0008`, but current main already applied ordinals `0009` through
`0011`, so the additive file moved forward to `0012`; its content and SHA-256
checksum are unchanged, and the historical `0005` through `0008` gap stays
empty.

`dispatchPlatformTool` was named above as the one future enforcement point for
blocked-action policy; FACT-23 now enforces `agents.guardrails.blockedActions`
there (see `docs/guardrails-enforcement.md`).

Run the disposable, real-PostgreSQL proof with:

```sh
npm run fact13:proof
```
