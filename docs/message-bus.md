# Durable PostgreSQL message bus

FACT-9 keeps the message plane inside PostgreSQL. `messages` remains the event
log from FACT-6. `message_consumptions` is the workflow engine's durable routing
receipt, with one primary-key row per message.

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

1. Try a transaction-scoped PostgreSQL advisory lock for a run with unconsumed
   messages. A bounded candidate scan lets another engine select another run.
2. Select that run's lowest unconsumed `sequence_number`.
3. Call the database-routing handler with the same `PoolClient`.
4. Insert the unique `message_consumptions` receipt.
5. Commit the handler mutation and receipt together.

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
in-flight transaction to finish. Handler failures reject the worker by default.
Supplying `onError` makes failure observation explicit and authorizes a retry
after the bounded retry interval.

Polling and durable PostgreSQL rows are authoritative. FACT-9 does not add
`LISTEN/NOTIFY`; the bounded poll already provides prompt local delivery without
introducing a second correctness path.

## Ownership and cleanup

The workflow engine alone writes `message_consumptions`. Its primary key is the
claim and acknowledgement index; `idx_message_consumptions_consumed_at` supports
operator inspection and explicit age-based retention work. `ON DELETE RESTRICT`
prevents a routed message from being deleted while its receipt exists. There is
no automatic cleanup in v1: retention must explicitly remove receipts before
their messages in one controlled operation.

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
handler failure and retry, restart before and after commit, late commits, and
clean idle and in-flight cancellation.
