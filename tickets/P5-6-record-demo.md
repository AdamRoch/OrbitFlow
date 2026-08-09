# P5-6 Record the demo

**Phase:** 5 · **Tag:** [CORE] · **Depends:** P5-1..P5-3 (all demo beats working)

Record the PRD §12 script — the demo is 40% of the grade and "the demo is the product."

## Script checklist

- [ ] `docker compose up` from clean clone.
- [ ] Load Software Factory template, tweak one node (e.g. plan mode), show agent editor + default prompts/skills.
- [ ] Text the orchestrator an app idea (phone on screen).
- [ ] Tickets materialize, workers fan out, trail streams; a question escalates to Telegram; answer from phone; run resumes.
- [ ] Test node rejects once → loop visibly routes back → passes.
- [ ] Final report text; cost tab totals.
- [ ] Bonus: scheduled standup text arriving (trigger manually, P5-3).

## Notes

- The rejection beat won't happen on cue by luck. Rig it honestly: the tester node's default prompt is strict (must run the checks, must reject on any acceptance-criterion miss), and the demo task is chosen so a first-pass miss is likely. Verify during dry runs that rejection actually fires; if it passes first try on the recorded take, keep rolling — a clean pass is fine, the loop just also needs to be shown once.

## Acceptance criteria

- [ ] One take, unedited flow works. Do at least one full dry run first; every beat above appears on screen.
