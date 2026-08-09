# P3-1 Telegram bot integration

**Phase:** 3 · **Tag:** [MUST] · **Depends:** P2-6 gate passed

grammY bot with long-polling — no public URL, fully local (PRD §9). Inbound chat messages become `channel_inbound` rows on the bus; `channel_outbound` messages from agents get sent to the chat. The engine wakes the channel-bound entry agent on inbound.

## Acceptance criteria

- [ ] Bot token via env var; runs inside compose.
- [ ] Inbound text → `channel_inbound` message → engine wakes the bound agent.
- [ ] Agent reply → `channel_outbound` → delivered to the chat.
- [ ] All Telegram traffic visible in the `messages` log (feeds the Trail tab, P4-5).
