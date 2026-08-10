# Durable PostgreSQL message bus

FACT-9 keeps the message plane inside PostgreSQL. `messages` remains the event
log from FACT-6. `message_consumer_runs` stores one fair per-run cursor,
`message_enqueues` is the indexed set of pending message identifiers, and
`message_consumptions` is the workflow engine's durable routing receipt, with
one primary-key row per message.

## Producer contract

Every future producer calls `insertMessage` from
`src/lib/postgres/message-bus.ts`. The helper validates the complete envelope,
inserts one row, and returns that durable row including the FACT-6
`sequence_number`. Pass a `Pool` for an autocommitted insert or a `PoolClient`
already inside `BEGIN` to make the insert participate in a larger caller-owned
transaction.

Do not allocate a sequence number in application code. The FACT-6 trigger takes
a transaction-scoped advisory lock per run, so visible sequence order is commit
order and rollback does not consume a number. The bigint message `id` identifies
the row; it is not a consumption cursor.

## Engine contract

`consumeNextMessage` routes at most one message in one PostgreSQL transaction:

1. Read a bounded window from the pending-run index and try a
   transaction-scoped PostgreSQL advisory lock for each candidate.
2. Select that run's lowest unconsumed `sequence_number`.
3. Call the database-routing handler with the same `PoolClient`.
4. Insert the unique `message_consumptions` receipt.
5. Advance the per-run cursor and move that run to the back of the fair queue.
6. Commit the handler mutation, receipt, and cursor together.

The workflow-run trigger initializes its consumer cursor. The message-insert
trigger adds a separate pending-message row, so producers never write the cursor
row used by consumers. After routing, the engine deletes that pending row and
updates its per-run `last_consumed_at`. Idle polling joins against an empty
pending table instead of rescanning history. Durable round-robin ordering moves
a run behind every other pending run, including runs beyond one candidate
window. The cursor is per run, never global, and the FACT-6 commit-order trigger
makes it safe from late-commit gaps.

The handler must perform database routing mutations only and must not issue
`BEGIN`, `COMMIT`, `ROLLBACK`, or release the supplied client. A failure rolls
back both the mutation and receipt, leaving the message eligible for retry. If a
connection dies before commit, PostgreSQL provides the same rollback. After a
successful or response-ambiguous commit, the unique receipt prevents another
committed routing transition.

The engine lock has a separate namespace from FACT-6's producer sequence lock.
An open producer therefore cannot block routing of an earlier committed
message, and a routing handler may insert another message with `insertMessage`
without creating an engine-versus-producer lock-order cycle.

This is exactly-once database routing, not exactly-once external effects. Later
effect executors must use durable dispatch records and idempotency keys before
calling OpenClaw, Telegram, or any other provider.

## Worker lifecycle

`runMessageBusWorker` and `startMessageBusWorker` poll sequentially. The default
idle poll is 100 ms; accepted poll and retry intervals are bounded from 10 ms to
60 seconds. One worker never starts a second handler while the first is active.
Cancellation stops new polls, interrupts an idle delay, and waits for any
in-flight transaction to finish. Cancellation also races a queued pool checkout;
a client acquired after abort is immediately returned without `BEGIN` or a
handler call. Handler failures reject the worker by default.
Supplying `onError` makes failure observation explicit and authorizes a retry
after the bounded retry interval.

Polling and durable PostgreSQL rows are authoritative. FACT-9 does not add
`LISTEN/NOTIFY`; the bounded poll already provides prompt local delivery without
introducing a second correctness path.

## Ownership and cleanup

The workflow engine alone advances `message_consumer_runs`, removes
`message_enqueues`, and writes `message_consumptions`; the insert trigger only
creates pending rows. The fair cursor index and pending-message primary key own
ready selection. The receipt primary key is the acknowledgement index, and
`idx_message_consumptions_consumed_at` supports
operator inspection and explicit age-based retention work. Receipt time uses
`clock_timestamp()` at insertion, not the transaction-start time returned by
`now()`, so a slow handler cannot make a fresh receipt look old.

`ON DELETE RESTRICT` prevents pending or routed messages from disappearing under
consumer state. Per-run cursors cascade only when a run can otherwise be
deleted; existing messages already restrict run deletion. There is no automatic
receipt cleanup in v1: retention must explicitly remove receipts before their
messages in one controlled operation.

## Disposable proof

Run:

```sh
npm run fact9:proof
```

The proof uses only the disposable container named
`orbitfactory-fact9-postgres-proof`, publishes PostgreSQL on a random localhost
port, applies the full clean migration chain, and removes that exact container
on exit. It covers validation and caller rollback, per-run commit ordering, two
engine connections racing one message, concurrent routing across runs,
handler failure and pool reuse, restart before and after commit, a fair window
larger than 32 active runs, late commits, wall-clock receipt aging, exhausted
pool cancellation, and clean idle and in-flight cancellation.
