# Live runtime evidence

This record separates runtime-boundary proof from the final product walkthrough.
It contains no credentials or generated source.

## Provider-free startup diagnosis

The first two application-enqueued build attempts ended before a provider request.
Both retained zero cost and zero tokens in the OrbitFlow ledger. The first failed
when OpenCode tried to install its plugin SDK in a 128 MiB temporary filesystem.
The second used a larger temporary filesystem but exposed a worse property: the
first project initialization could wait indefinitely while the same dependency
was installed into a disposable home. OrbitFlow cancelled both exact runs through
its API, and their exact per-turn containers were removed. A Telegram conversation
queued behind the second run was also cancelled before execution, so it could not
enter the stale runtime.

The corrected image pins and preinstalls `@opencode-ai/plugin@1.18.29` beside
`opencode-ai@1.18.29`. A fresh hardened container then passed its *first* session
creation in 0.049 seconds: health returned version `1.18.29`, `POST /session`
returned HTTP 200 for a session rooted at `/workspace`, and the disposable home
used about 528 KiB while the 63 MiB plugin tree remained in the read-only image.
The container used the production read-only root, dropped capabilities,
`no-new-privileges`, host UID/GID, 1 GiB memory, 1.5 CPU, 160-process, and 256 MiB
temporary-filesystem limits. No provider credential was supplied to this probe.

A subsequent UI-enqueued run exposed a separate port-readiness race. Docker had
published the mapped port, but the first Node health request connected before
OpenCode was ready and remained open behind the proxy. That request had inherited
the full turn timeout, preventing the intended health retry. OrbitFlow cancelled
the run at zero ledgered spend and now bounds each health request to one second
and session creation to 15 seconds.

The actual production `executeTurn` startup path was then run with a dummy provider
value and aborted synchronously after authenticated session creation. It emitted
`Starting OpenCode 1.18.29`, `Runtime ready`, and `Session ready`; returned a
`RuntimeFailure` carrying zero cost and zero tokens; and removed its exact
container. The abort check precedes the model request. A provider account baseline
check independently showed no usage change across these startup attempts.

The final runtime path also receives the smaller of the agent's remaining cost
allowance and the application's remaining authorized provider budget. Repeated
streaming updates replace the prior cost for the same assistant message, avoiding
double counting, and the runtime aborts when observed cumulative cost reaches the
remaining allowance. This is an observed-cost stop rather than a hard dollar cap:
the provider exposes cost after a response, so that in-flight response can overrun
the threshold. The next recorded provider run must demonstrate the resulting
ledger behavior.

## Paid workflow evidence

A UI-enqueued Builder turn completed through OpenRouter and retained `index.html`
as revision `c635d897-df10-411a-b65d-b7177a1dd88d`, awaiting human approval. Its
durable events show native read, write, and structured-result tools. Four unique
assistant-message snapshots reported a partial $0.21679035, 20,099 inclusive input
tokens, and 10,842 inclusive output tokens. OpenRouter's account total increased
by $0.27685665 across the run, so the smaller event total is not a complete cost
record. The database correctly retained unknown cost rather than presenting the
partial event total as final. For this historical run, $0.27685665 is the
conservative reconciled provider cost; exact complete token counts are unknown.

The missing event came from closing the stream as soon as the structured tool
completed, before OpenCode published the final assistant cost. The runtime now
connects SSE before sending the prompt, replaces snapshots by message ID, waits
up to eight seconds for the exact session's `session.idle`, requires the response
assistant ID, and accepts usage only when every assistant snapshot is complete.

A paid no-tool diagnostic then exposed the message-list failure precisely:
OpenCode `1.18.29` returned HTTP 400 `BadRequest` because its history decoder
rejected the stored `OutputFormatJsonSchema` that the prompt endpoint had accepted.
Provider-free probes showed HTTP 200 raw arrays for empty history and for a real
user-only history, so this is specific to the structured assistant session. The
successful path now uses the complete SSE contract; a single bounded history read
remains best effort for failures.

The next Builder run used saved memory for light neutral surfaces, restrained
forest-green accents, no decorative emoji, and keyboard-accessible controls. The
effective OpenCode prompt contained all four directives. Browser inspection then
confirmed the resulting style, working routine creation and workout logging,
localStorage persistence across reload, and usable weekly progress at 400 px.
Its complete usage was $0.30846060, 51,365 inclusive input tokens, and 12,690
output tokens, exactly matching the OpenRouter account delta.

That Builder correctly returned `review` and created a durable handoff to the
Reviewer. The first Reviewer attempt completed seven native read cycles, then
failed on cycle eight with five identical retries: Claude 4.6 rejected an
assistant prefill. Pinned OpenCode source showed that `agent.steps` injects
`MAX_STEPS_PROMPT` as an assistant message on its last native cycle. Anthropic's
current documentation confirms Claude 4.6 does not support prefills. OrbitFlow had
incorrectly mapped the eight-turn workflow guardrail to eight native cycles. The
mapping is removed; the engine still enforces agent turns, while cost and time
limits bound native cycles. The failed Reviewer's complete event usage was
$0.10499730, 108,970 inclusive input tokens, and 461 output tokens, also an exact
provider-account match.

The earlier Builder returned `completed`, which did not traverse the template's
`review` edge. Explicit terminal outcomes and a constrained structured outcome
schema now prevent that bypass. The next build retained a real Builder-to-Reviewer
handoff, but its review has not yet reached a conclusion.

The resumed Reviewer made 107 completed tool/model cycles and reached its observed
$2 limit. Its first read delivered all 979 source lines; it then inspected small,
mostly distinct 10–20-line ranges. OrbitFlow's event display truncation occurs
after OpenCode's model/tool exchange and did not truncate the model's source.
The complete assistant snapshots total $2.007993, 5,387,073 inclusive input tokens,
and 8,003 output tokens, matching the provider delta exactly. The old Reviewer
had inherited a Builder procedure. Current Reviewer configurations and templates
now provide an explicit efficient source-review procedure. The exhausted frozen
run remains retained; a new run must establish the corrected end-to-end behavior.

A real Telegram conversation completed as run
`3721a515-6d21-49ad-8e94-124daee363ce`. OrbitGuide addressed Adam using saved memory
and returned through the real new bot. Complete SSE usage was $0.00796575,
1,664 input and 116 output tokens. Its initial command advice exposed a channel
context omission; the channel now supplies its actual command syntax and supports
a guided natural-language improvement request. Its completion footer now links
source and preview only when the run actually retained a revision.

The next two-agent workflow reached human approval with complete retained usage,
but its Reviewer exposed a native image defect: all `grep` and `glob` calls failed
with `ripgrep execution failed`. Inspection confirmed that the pinned runtime image
did not contain `rg`. The corrected image pins Debian ripgrep `13.0.0-4+b2`.
A provider-free container using the production read-only root, dropped
capabilities, non-root UID/GID, process, memory, CPU, and temporary-filesystem
limits then ran both `rg --files` and a content regex successfully against a
mounted workspace. This proves the missing executable and isolation boundary;
the subsequent real Reviewer turn also completed OpenCode native grep calls.

The cancelled startup attempts are not agent demonstrations. They prove the
failure and cancellation boundary only; neither produced a model response,
generated artifact, or provider charge.

## Real build, schedule and human revision

Build `e3bb9196-d0d1-4515-8589-d28fb41fdf3b` completed Builder and Reviewer
with $0.32415990, 129,489 input tokens and 12,078 output tokens, retaining
revision `157cba34-cc7f-4d79-aee5-924752776035`. Native Chrome created Morning
Strength, saved a 25-minute workout and notes, reloaded, and inspected retained
routine/log/progress data.

Scheduled run `d7abc622-0e56-4010-8e2a-6d63d680a6a9` woke from an actual saved
`@every 1m` schedule. Its durable request sender is `schedule:<OrbitGuide ID>`.
The real runtime greeted Adam from saved memory and completed at $0.005832,
1,251 input and 77 output tokens. The schedule was disabled immediately after
its first enqueue; no schedules remain enabled.

A native Safari check found keyboard focus escaped the routine dialog. Human
feedback was submitted through the real approval API and Builder revised the
retained application as `f8445e77-57dc-45a8-bd00-cadca6f5fdef`, preserving storage
keys. Safari then verified Shift+Tab wraps from Close to Save, Tab wraps back,
and Escape restores focus to New Routine. The revised preview renders at 400px.
The next Reviewer successfully used native grep from the corrected image, but
spent the remaining first-$5 allowance on excessive searches. A bounded resume
also exhausted its remaining agent allowance. The whole run was conservatively
reconciled to $2.94486300 from the isolated provider account increase minus
other known runs; tokens remain explicitly incomplete. It remains failed.
Adam's authorized total ceiling is $10.

Chrome native AX and screenshot access failed while opening responsive tools.
Safari remains accessible. The fifth actual Chrome recording is unsaved; no
final integrated video is claimed until it is recovered and the real Telegram
improvement is demonstrated.

## Approved final build

Build `b23172ee-f1ef-41df-8e3c-d898f802fc2d` completed four real turns:
Builder, Reviewer feedback, Builder revision, and Reviewer approval. Current
Reviewer configuration uses `openrouter/openai/gpt-5.4`; Builder remains
`openrouter/anthropic/claude-sonnet-4.6`. The same graph engine and native runtime
executed both roles. Reviewer identified the streak calculation for a streak
ending yesterday; Builder corrected it and Reviewer approved.

Final revision `bed55348-b080-45ef-a3db-3eeaf186c348` retained complete SSE
usage of $0.33209005, 141,555 inclusive input tokens and 11,531 output tokens.
Native Safari created Morning Strength with Push-ups 3 x 10, saved a 25-minute
workout and notes, reloaded, and verified the routine, log and weekly totals.
The 400px weekly view was readable. Escape dismissed the native edit dialog;
full keyboard accessibility is not claimed (Safari can move focus to browser
controls). The exact revision was approved through the real API at
2026-09-06T14:36:14Z. Adam's final walkthrough remains pending.

Recorded application spending is $5.99954485 of the $10 authorization after
this build. The actual Telegram improvement of this approved application and
its final recorded demonstration were pending browser connection recovery at that checkpoint; both subsequently completed as described below.

## Final Telegram improvement and recorded local demo

Chrome native access recovered when its sharing overlay became accessible.
Stopping that share saved the fifth recording without quitting Chrome. A new
explicit browser-window recording captured the final path.

At 2026-09-06T16:45:09Z, a real Telegram `/improve` message selected approved
build `b23172ee-f1ef-41df-8e3c-d898f802fc2d`. The next ordinary message,
“Add a way to duplicate a routine,” created run
`c87477ac-1fc1-4eb4-a6e9-7546fc496c92`. Real Improver and Regression Reviewer
turns used native file tools, exchanged a durable handoff, and retained revision
`4aec810a-eb97-4d2e-aed7-a8b44825d1e6`. Complete usage was $0.12761785,
108,357 inclusive input tokens and 1,435 output tokens.

Native Chrome created a routine and 25-minute workout on the original approved
revision, reloaded it, opened the improved revision on the same application
origin, and confirmed both data and weekly totals survived. Duplicate produced
Morning Strength (Copy); both routines survived reload. The exact pending
revision was approved through the real Telegram `/approve` command at
16:47:46Z. Source inspection by the Reviewer is explicitly distinguished from
these browser checks.

Safari independently opened the update with data saved before the Telegram
request. At 400px, Duplicate worked, editing the copy left the original unchanged,
and both persisted after reload. Its original 25-minute workout and notes remained.

A subsequent real Telegram conversation
`4d4a433e-9c6b-4f27-8ee6-d86fee437bda` replied “I have your name saved as Adam.”
Complete usage was $0.01044075,2,540 input/62 output tokens. Its corrected
conversation-only footer made no source or preview claim.

The original final recording is retained privately as
`.local/recordings/telegram-improvement-approved.webm`. The reviewable local
video and provenance are in docs/demo. No simulated response or generated
animation substitutes for the real workflow. Total application cost is
$6.13760345, exactly matching the provider account increase from the saved
pre-demo baseline. No runs are active and all schedules are disabled.

Implementation, focused local checks and real local provider/channel demo are
complete. Adam's final walkthrough remains pending. There is no cloud/public
deployment, arbitrary backend support, hard provider-side spending guarantee,
or full accessibility audit claim.
