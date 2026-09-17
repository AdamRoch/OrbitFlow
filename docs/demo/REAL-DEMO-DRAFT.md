# OrbitFlow real demo draft

[`orbitflow-real-demo-draft.mp4`](./orbitflow-real-demo-draft.mp4) is a 2:30 edit of actual local browser recordings from earlier development runs. Idle pauses were removed. The edit preserves the order of actions within each source recording and does not use staged responses or a simulated application.

This is draft evidence. It is not the final `b231` acceptance run, and the final Telegram-driven improvement remains pending.

## Sources

- `.local/recordings/build-handoff-preview-and-recovery.webm`
  - `00:24–00:33`: submit the workout tracker request and open run `454bec11-40da-4d19-b362-a5fff5edd772`
  - `01:38–01:52` and `02:12–02:23`: inspect the saved agent configuration and workflow graph
  - `04:14–04:20` and `04:35–04:58`: open the generated preview and create a routine
  - `05:40–06:01`: log a completed workout
  - `06:15–06:43`: inspect the generated application at a narrow viewport and open weekly progress
  - `08:35–08:42`: reload the preview and retain the populated progress data
- `.local/recordings/telegram-conversation-and-review-limit.webm`
  - `00:30–00:45`: inspect the real Telegram conversation for completed run `3721a515-6d21-49ad-8e94-124daee363ce`, including its historical `/improve` instruction. That old reply incorrectly claimed source/preview availability for a conversation-only run; the footer and guided command context were subsequently fixed. This footage proves real conversation and memory, not those corrected commands

The original recordings remain unchanged. Review frames and encoding intermediates are retained under `.local/recordings/frames/` and `.local/recordings/draft-parts/`.
