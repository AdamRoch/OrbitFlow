# Telegram navigation and guided requests

Status: accepted implementation choice for Adam's September 17 Telegram UX request. Deployment and live Telegram acceptance remain separate. No experiment workflow or model configuration is part of this change.

Read workflow and agent discovery directly from saved configuration. Navigation never calls a model. Preserve the single configured Telegram conversation agent; browsing agents is read-only. Keep editing in the web UI. Recent-run controls remain limited to this chat's runs; approved application selection retains the existing single-operator workspace access.

Use Telegram inline buttons and a chat-scoped command menu. Persist opaque, chat-bound button references in integration_state because Telegram callback data is limited to 64 bytes, while run IDs and approval tokens together exceed that limit. References expire after 24 hours and expired references are removed hourly. Approval actions carry the original approval token and still pass through the engine's atomic approval check. Stopping a run requires a distinct confirmation; cancelling a pending request does not stop execution.

Persist guided request state with its workflow/agent configuration fingerprint and selected source revision. Recheck those values when the request is submitted. A consumed request keeps a delivery receipt so redelivered text cannot become an unrelated conversation turn; enqueue also uses a stable request idempotency key. Pending context is shown alongside menus and can be cleared explicitly. Existing textual commands and already-persisted improvement requests remain supported.

Keep Telegram command parsing and menu handling separate from the existing polling, durable outbox, and scheduler. Add reply markup to persisted outgoing messages so retries retain their buttons. Telegram still provides no send idempotency key: a crash after Telegram accepts a message but before its receipt is saved can duplicate the reply. This change does not claim exactly-once external delivery.
