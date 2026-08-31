# FACT-13 platform tool surface

`bin/orbit-agent-tools.mjs` is the production agent CLI. It accepts six commands
and a single JSON argument:

```sh
node bin/orbit-agent-tools.mjs create_ticket '{"agentId":"1","runId":"1","projectId":"1","title":"Investigate queue","idempotencyKey":"turn-12-create-1"}'
node bin/orbit-agent-tools.mjs update_ticket '{"agentId":"1","runId":"1","ticketId":"1","expectedUpdatedAt":"2026-08-10T12:00:00Z","status":"todo","idempotencyKey":"turn-12-update-1"}'
node bin/orbit-agent-tools.mjs set_ticket_dependencies '{"agentId":"1","runId":"1","ticketId":"1","blockerTicketIds":["2"],"idempotencyKey":"turn-12-dependencies-1"}'
node bin/orbit-agent-tools.mjs post_message '{"agentId":"1","runId":"1","ticketId":"1","recipient":"agent:reviewer","type":"question","payload":{"question":"Should this be split?"},"idempotencyKey":"turn-12-question-1"}'
node bin/orbit-agent-tools.mjs list_projects '{"agentId":"1","runId":"1","idempotencyKey":"turn-12-projects-1"}'
node bin/orbit-agent-tools.mjs list_tickets '{"agentId":"1","runId":"1","idempotencyKey":"turn-12-list-1"}'
```

The CLI emits one bounded JSON response to stdout and does not require an API
credential. `DATABASE_URL` is its only configuration. Every command requires
an idempotency key and agent/run attribution. A ticket-bound broker invocation
injects the active dispatch's ticket id. A planner has no active ticket, so its
dependency command supplies a target ticket id that PostgreSQL validates
separately. Ticket creation derives the new ticket attribution in the same
PostgreSQL transaction.

OpenClaw does not invoke this attribution-bearing CLI directly. Its only
allowlisted executable is `bin/orbit-openclaw-tool.mjs`, which reads the
engine-written active-dispatch context from the synchronized agent workspace,
rejects model-supplied attribution fields, and sends that bounded request over
a Unix socket to the separately privileged tool broker. The broker independently
reloads the engine-written context, verifies it against the currently leased
PostgreSQL dispatch, and invokes this CLI with the bound agent, run, and ticket
ids. Neither the OpenClaw gateway nor the allowlisted wrapper receives a
PostgreSQL credential.

`update_ticket` and `post_message` require a ticket-bound dispatch and the
broker always replaces their ticket id with the active ticket. A planner
dispatch has no active ticket, so its `set_ticket_dependencies` call includes
an explicit target ticket id from `list_tickets`; PostgreSQL then validates its
run, project, todo state, dependency graph, and idempotency. If a ticket-bound
dispatch calls `set_ticket_dependencies`, the broker replaces any supplied
target with the active ticket before invoking the CLI.

Every CLI invocation enters `dispatchPlatformTool`. That typed dispatcher is the
one future enforcement point for P5-1 blocked-action policy. It validates the
closed input schema before opening a transaction, checks the agent, run, and
ticket ownership directly in PostgreSQL, and uses parameterized SQL only.

`list_projects` gives a fresh run the durable project ids accepted by
`create_ticket`. `set_ticket_dependencies` replaces a todo ticket's complete blocker
set. The blocked ticket and every blocker must be in the calling run and project.
It locks the workflow run before the idempotency invocation's run foreign-key lock
and before ticket rows, rejects cycles, and touches the blocked ticket so Monitoring
wakes after the transaction commits. Every `update_ticket` takes that same run lock
first, so dependency replacement, ticket edits, and engine assignment have one
per-run linearization order. `list_tickets` returns the current blocker ticket
ids. `create_ticket` and `update_ticket` append a `system` message. `post_message`
appends the requested message type, including `question`. All use FACT-9's
`insertMessage` producer inside the ticket transaction, so the ticket mutation,
durable message, enqueue, ready projection, and idempotency result commit or
roll back together. `list_projects` and `list_tickets` are read-only;
`list_tickets` is scoped to the calling run, and
records its durable idempotent invocation in the same PostgreSQL authority.

Agents may create `backlog`, `todo`, `done`, or `canceled` tickets, but they cannot
create or update a ticket to `in_progress`. Created tickets have no assignee. The
workflow engine makes the first assignment when it atomically creates the ready
ticket's first dispatch. A `done` blocker cannot move to a non-`done` status when a
direct dependent is `in_progress` or `done`; the update fails with
`ticket_reopen_conflict` and rolls back. `backlog`, `todo`, and `canceled` do not
prove that a dependent consumed the blocker. This preserves the readiness snapshot
behind already-started work, including sequential rework that remains `in_progress`.
A non-status `update_ticket` keeps the ordinary ticket and idempotency behavior.

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

FACT-49 adds the production-boundary proof for the dependency command:

```sh
npm run fact49:proof
```

That gate uses the FACT-34 Compose topology and a local provider boundary. A
real OpenClaw gateway agent invokes the committed allowlisted wrapper over the
Unix socket into the broker for both a ticketless planner dispatch and a
ticket-bound implementer dispatch. PostgreSQL checks the planner's supplied
target and blocker set, then verifies a bound implementer cannot replace its
target or attribution. The proof is credentialless, checks database identity
and the running allowlist, and fails if exact Compose cleanup does not remove
every disposable resource.
