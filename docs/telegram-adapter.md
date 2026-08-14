# Telegram adapter

FACT-15 runs one grammY long-polling process in the optional `telegram` Compose
profile. It has no public listener or webhook. Start it only after setting
`TELEGRAM_BOT_TOKEN`:

```sh
docker compose --profile telegram up --build
```

This is the canonical Telegram-enabled demo command. It requires the normal
Compose variables plus `TELEGRAM_BOT_TOKEN` in `.env`; the default Compose
command deliberately leaves this adapter off.

`src/runtime/telegram.ts` maps text-only Telegram updates to
`ingestTelegramInbound`. The adapter stores the chat and sender identity, text,
Telegram update id, Telegram message id, and optional
`reply_to_message.message_id` in the normal `messages` row. The same transaction
creates a channel workflow run and a Telegram-specific update receipt. A
repeated long-poll update returns the original run/message instead of starting
a second workflow.

An explicit reply to a sent, pending Factory question is stored as an `answer`
for that exact run and ticket. Correlation requires the Telegram chat id and
replied-to message id to match the durable outbound delivery. Missing,
mismatched, and stale reply identities remain ordinary `channel_inbound`
messages; they never select a pending question by recency.

The binding lives on the receiving agent as:

```json
{ "provider": "telegram", "workflow": "Software Factory" }
```

The selected workflow entry must name that agent and set
`config.channelBinding: true`. The bus then routes `channel_inbound` through the
normal workflow-engine transaction; it creates the entry dispatch with the
inbound row as its upstream input. The runtime gets the human text as the
handoff brief and the complete chat identity in `upstream.output`.

Agents publish replies only as `channel_outbound` `messages` rows:

```json
{ "provider": "telegram", "chatId": "123", "text": "Reply text" }
```

The Telegram worker polls those retained rows and records one delivery receipt.
After the provider call starts, a crash or error is marked `indeterminate`, not
retried, because Telegram's send API has no client idempotency key. Operators
must resolve an indeterminate delivery explicitly rather than risking a
duplicate user message.

OpenClaw's Telegram channel is explicitly disabled in
`docker/openclaw/openclaw.json`. OrbitFlow is therefore the only Telegram
long-poll consumer.

## Proof

```sh
npm run fact15:proof
```

The proof starts a disposable PostgreSQL database, applies the complete
migration chain, uses a fake Telegram HTTP boundary, and checks inbound
persistence/deduplication, normal engine wake dispatch, outbound delivery,
unsupported update handling, retained message-log rows, and the shipped
OpenClaw-off invariant. It also validates the opt-in Compose profile with a
non-secret fake token.

FACT-37's focused reply-correlation proof also uses only a fake Telegram
boundary and a disposable database:

```sh
npm run fact37:proof
```
