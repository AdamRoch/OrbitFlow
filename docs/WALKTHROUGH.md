# Adam's local walkthrough

The app is already running at http://127.0.0.1:4310. To start it again, run `npm run setup` from `/Users/adam/orbitflow-v2` and leave that command running. Docker Desktop and Node 22.12+ are required. No original OrbitFlow service or bot is used.

1. Open Runs. Select the completed workout-tracker build beginning `b23172ee`. Inspect Saved execution setup and the Builder → Reviewer → Builder → Reviewer messages. Open Source to see retained HTML and Preview to use it.
2. Select the completed “Add a way to duplicate a routine” run beginning `c87477ac`. Its request comes from Telegram; its handoff goes from Improver to Regression Reviewer. Inspect the final approval and open Preview.
3. In Chrome, Morning Strength and its copy are saved. Duplicate a routine, edit the copy, reload, and check the original and 25-minute weekly log remain. Safari has separate saved data and an independently edited copy; browser profiles do not share localStorage.
4. Open Agents and Workflows to inspect editable memory, skills, model/tool access, approval policy, limits, schedules and route conditions. Both loaded templates are ordinary editable graphs. Settings apply to new runs; old runs retain their snapshots. Schedules are currently off.
5. For another real change, open Telegram's @adam_orbitflow_v2_0906_bot chat. Send `/improve`, then your change. Inspect the resulting revision before approving with the exact command in the bot reply. This spends provider credit; the configured total budget is $10 and recorded usage is $6.13760345.

The [demo video](demo/orbitflow-real-demo.mp4) records the real Telegram improvement and conversation. [Evidence](live-runtime-evidence.md) distinguishes focused tests, provider runs and native browser checks. Your walkthrough is final acceptance.

Preview links are local to this Mac. Source is retained in PostgreSQL; application data stays in that browser profile's localStorage. Ctrl-C stops the new app and any active turn while leaving the database volume intact. `docker compose stop` stops only this repository's database. Do not remove its volume to restart.
