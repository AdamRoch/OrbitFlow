# OrbitFactory — Product Requirements Document

AI agent orchestration platform. Users create agents, configure how they behave (personality, tools, schedules, memory, limits), and connect them into collaborative workflows executed on a real runtime. Flagship template: a "Software Factory" — text an idea to an orchestrator agent on Telegram and watch a crew plan, implement, and test it, with live progress on a ticket board.

Built for the Yuno platform challenge. This document is written to be decomposed into tickets by a planning agent. Every requirement is tagged [MUST] (spec must-have), [CORE] (needed for the demo narrative), or [STRETCH] (build only after Phase 5 is done).

---

## 1. Product framing

- OrbitFactory is a **platform, not a product**. The Software Factory is template #1 built on generic primitives. Nothing about the factory (agent roles, loop shape, ticket usage) may be hardcoded into the engine.
- Codebase foundation: fork of OrbitTrack (existing ticket tracker by the author). Ticket schema, board UI, and branding are inherited; workflow builder, agent config, and observability pages are added. Unused OrbitTrack routes/features must be deleted, not left dormant.
- Runtime: **OpenClaw** is the execution engine for all agents. Coding work is performed by agents *delegating* to one headless coding CLI as a tool (see §5). This framing must remain true in implementation: agent judgment (reading tickets, deciding approach, reviewing diffs, writing handoff briefs, posting questions) executes on OpenClaw.

## 2. Evaluation mapping (why each piece exists)

| Spec criterion | Weight | Answered by |
|---|---|---|
| Working end-to-end demo | 40% | Phases 0–4; demo script §12 |
| Architecture & code quality | 30% | Plane separation §3, adapter interfaces §5, tests §11 |
| UI/UX & configurability | 20% | Node config §7, agent editor, board, monitoring §9 |
| Documentation | 10% | README reqs §13 |

Key impact metrics to optimize: configurable dimensions per agent; time from zero to working workflow; task completion rate; agent-to-agent message reliability.

## 3. Architecture: three planes

1. **Control plane** — backend service. Source of truth for agents, workflows, runs, tickets, messages, schedules, cost events. REST for CRUD; WebSocket (or SSE) pushing all state changes to the UI.
2. **Execution plane** — `RuntimeAdapter` for OpenClaw: create/configure agents, wake with a composed prompt, capture structured output + events + token usage, terminate. Plus one `CodingToolAdapter` (see §5).
3. **Message plane** — DB-backed bus. A `messages` table is the single event log. The **workflow engine** consumes new messages, evaluates the active run's graph, and dispatches the next wake-up. No queue infra (no Redis/RabbitMQ); Postgres LISTEN/NOTIFY or an engine-internal poll loop.

**Prime rule: the engine owns transitions; agents own judgment inside their node.** Routing is deterministic graph evaluation over structured agent output. Agents never decide who runs next.

**Event producers into the bus:** external channel messages (Telegram), UI actions, cron ticks (§8), agent outputs. All become `messages` rows; the engine is the only consumer that routes.

## 4. Data model

Tables (Postgres). Columns listed are the load-bearing ones; add timestamps/ids everywhere.

- `agents` — name, role, system_prompt, model, skills[], coding_tool_enabled, guardrails (cost limit, rate limit, blocked actions), interaction_rules (may_answer_questions, autonomy level), channel_binding (nullable), openclaw_ref
- `skills` — name, description, procedure (markdown), attached via join table to agents
- `workflows` — name, description, graph JSON (nodes + edges + conditions), is_template flag
- `workflow_runs` — workflow_id, status, trigger_type (channel|ui|cron), spec (structured task), started/ended, aggregate token/cost totals
- `tickets` — (inherited from OrbitTrack, extended) run_id, title, description, acceptance_criteria, status, assignee_agent_id
- `messages` — run_id, ticket_id (nullable), sender (agent|human|system), recipient, type (`output` | `feedback` | `question` | `answer` | `channel_inbound` | `channel_outbound` | `cron_tick` | `system`), payload JSON, handoff_brief (nullable), token_usage (nullable)
- `schedules` — cron expression, target (workflow_id | agent_id + task prompt), enabled
- `cost_events` — run_id, agent_id, model, tokens_in/out, computed cost

[MUST] Message history must fully reconstruct the inter-agent conversation trail per run for the UI.

## 5. Runtime integration

### OpenClaw adapter [MUST]
- Programmatically create/update an OpenClaw agent from an `agents` row (persona/system prompt, memory, tools).
- Wake an agent with a composed prompt; capture structured output; detect completion reliably; capture per-turn token usage into `cost_events`.
- Per-agent memory: persistent facts/preferences survive across runs [MUST]. Store canonical memory in the platform DB; sync into OpenClaw's memory files on wake.

### Prompt composition (delivery-time)
The adapter composes every wake-up prompt from: node system prompt + workflow/run context + assigned ticket(s) + **upstream handoff brief** + agent memory + output-format contract.

### Agent output contract
Every agent turn must emit structured output: `{artifact, handoff_brief, events[]}`. The handoff brief (intent, decisions made, constraints discovered, warnings for the next agent) is required — this is what keeps deterministic routing from being lossy. Enforced by prompt contract + output validation; malformed output triggers one retry then a `system` error message.

### Platform tool surface (agent-callable)
Platform-owned CLI that OpenClaw agents invoke through its supported `exec` tool: `create_ticket`, `update_ticket`, `post_message` (incl. type=question), `list_tickets`. Each command has a narrow argument contract and writes DB rows → WebSocket events → UI updates. The platform validates structured invocation records; it never scrapes terminal output or trusts the agent's prose as evidence. The Phase 0 proof, registration method, and execution-boundary constraints live in `docs/fact-2-platform-tool-spike.md`.

### CodingToolAdapter [CORE]
- One headless coding CLI wrapped as an agent tool `delegate_coding_task(task, workspace) -> {diff, log, usage}`.
- v1 ships exactly one implementation, chosen in Phase 0. Constraint: must authenticate via a single env-var API key so an evaluator's `docker compose up` works.
- The interface is designed for plurality (harness selection per agent is [STRETCH]), but only one implementation is built.
- The implementer agent must review the returned diff and iterate or accept — delegation is a tool call inside agent judgment, not a passthrough.

## 6. Agent CRUD & configuration [MUST]

UI to create/edit/delete agents with every `agents` field above: name, role, system prompt, model, tool access, channel binding, schedules, memory (viewable/editable facts), skills, interaction rules, guardrails. Templates ship with opinionated default system prompts; the **contract** (output schema, tool surface, message types) is fixed per node type and not user-editable.

Guardrails enforcement [MUST]: per-agent and per-run cost ceilings checked by the engine before each wake; rate limits; blocked actions list passed into the prompt AND enforced at the tool surface where possible.

## 7. Workflow model & builder [MUST]

- Workflows are graphs: nodes (agent + node config) and edges (conditions over structured output, e.g. `verdict == "rejected" -> back to implement`).
- Visual builder: React Flow. Create/edit nodes and edges, set conditions, save as workflow. Feedback loops must be drawable, not hardcoded.
- **Node config fields** (each is a configurable dimension — surface them well):
  - entry node flag + channel binding (which agent fields inbound Telegram)
  - fan-out: run over open tickets, max N concurrent workers (ephemeral worker sessions per ticket)
  - plan mode: off | allowed | required, with guidance tooltips (cheaper model → require planning)
  - may_answer_questions: bool
  - question escalation target: agent | human-via-channel | human-via-UI
  - approval gate: pause for human approval before/after node [MUST — interaction rules]
- Question/answer flow: agent posts `type: question` on its ticket → engine pauses that thread only → routes per escalation config → `answer` message resumes it. This one mechanism covers the Q&A trail, approval gates, and mid-run Telegram interaction.
- Templates [MUST, ≥2]: **Software Factory** (orchestrator → planner → implement fan-out → test loop; testing node deletable) and **Research Pipeline** (orchestrator → researcher fan-out over research-task tickets → synthesizer → reviewer loop). Both loadable and editable from the UI.

## 8. Scheduling [MUST]

- Cron lives in the platform engine (node-cron), NOT OpenClaw's scheduler — every tick becomes a `cron_tick` message so all wake-ups are observable in one event log. Note this tradeoff in README.
- Two schedule targets: trigger a workflow run; wake a single agent with a standing task prompt.
- Ship with one live example: orchestrator's **daily standup** — texts the user a summary of ticket movement + spend. [CORE — demo beat]

## 9. Channel integration & monitoring

### Telegram [MUST]
- grammY bot, long-polling (no public URL; fully local).
- Inbound → `channel_inbound` message → engine wakes the channel-bound entry agent (orchestrator). Outbound agent replies → `channel_outbound` → sent to chat.
- Orchestrator standing duties: intake (clarify → emit structured run spec), status queries ("how's it going"), question escalations, final report, scheduled standup.
- UI shows each agent's channel binding [MUST].

### Live monitoring [MUST]
Tabs, all fed by the same WebSocket stream:
1. **Board** — inherited OrbitTrack ticket board, live-updating per run.
2. **Trail** — inter-agent message feed incl. Telegram traffic, filterable by run/agent/type.
3. **Agents** — status (idle/working/waiting-on-question), current task, logs.
4. **Cost** — token/cost per run and per agent from `cost_events`; ceilings shown against actuals.

## 10. Phased build plan

**Phase 0 — Spike (≈ half a day, code becomes the adapter):**
1. Programmatically create two OpenClaw agents with distinct personas/memory; wake each with a prompt; capture structured output and token usage; detect completion.
2. From inside an OpenClaw agent, call a custom platform CLI tool and capture the call.
3. Wrap the candidate coding CLI headless: submit task, get diff + usage. Pick the v1 CodingToolAdapter based on results.
4. Send the Yuno clarification email (see §14) — do this before writing more code.
Exit criteria: all four proven or the architecture is revised HERE.

**Phase 1 — Foundation:** fork OrbitTrack; strip unused features; stand up schema (§4); docker-compose (app + Postgres + engine) with single-command run; CRUD API for agents/skills/workflows.

**Phase 2 — Engine spine:** message bus + workflow engine executing a hardcoded-in-DB Software Factory graph end-to-end with real OpenClaw agents and real coding delegation on a trivial task. **This is the E2E moment — nothing else proceeds until a run completes.**

**Phase 3 — Telegram:** inbound intake through orchestrator → run kicked off from a text; status query; final report to chat.

**Phase 4 — UI:** agent editor; React Flow builder with node config; both templates loadable; board + trail + agents + cost tabs live.

**Phase 5 — Hardening:** guardrails enforcement; question/escalation + approval gates; scheduling + daily standup; tests (§11); README + architecture diagram; record demo.

**Phase 6 — [STRETCH], only if 0–5 done:** model cost advisor (OpenRouter models API → per-node cheaper-model suggestion chip); per-agent harness selection dropdown (second CodingToolAdapter); anything else.

## 11. Tests (critical paths) [MUST]

- Agent CRUD round-trip (API + persistence).
- Workflow engine: graph evaluation incl. rejection loop and fan-out (mock adapter).
- Message delivery: producer → bus → engine dispatch → adapter called with composed prompt (mock runtime).
- Telegram inbound → run created (mock bot API).
- Guardrail: cost ceiling halts a run.

## 12. Demo script (record this)

1. `docker compose up` from clean clone.
2. Open UI: load Software Factory template, tweak one node in the builder (e.g. toggle plan mode), show agent editor + default prompts/skills.
3. Text the orchestrator an app idea on Telegram (phone on screen).
4. Watch: tickets materialize on the board, workers fan out, trail tab streams messages, a question escalates to Telegram, you answer from your phone, run resumes.
5. Test node rejects once → feedback loop visibly routes back → passes.
6. Orchestrator texts the final report. Show cost tab totals.
7. Bonus beat: the scheduled standup text arriving.

## 13. README requirements [MUST]

Architecture diagram (draw before coding); setup instructions (single command); runtime choice justification (OpenClaw vs OpenCode vs Goose — include the coding-CLI-as-tool framing and the Firstmate lineage of the dispatch/handoff-brief patterns); language/stack justification; how to add a new workflow template; how to add a new messaging channel; honest note that the UI foundation is adapted from OrbitTrack; scheduling-in-engine tradeoff note.

## 14. Risks & open questions

- **Runtime framing risk:** "choose one runtime" vs. coding-CLI-as-tool. Mitigation: clarification email to Yuno (send in Phase 0); regardless of answer, keep agent judgment demonstrably on OpenClaw.
- **OpenClaw programmatic control** is the biggest technical unknown — hence Phase 0 gate.
- **Completion detection / output validation** of agent turns; mitigation: strict output contract + retry + system-error messages.
- **Evaluator-runnable auth:** every default path must work with env-var API keys only.
- **Scope:** stretch items are quarantined in Phase 6; the demo is the product.

## 15. Non-goals (v1)

Multi-user/auth, cloud deployment, WhatsApp/Slack (Telegram only), more than two templates, harness marketplace, model fine-tuning, mobile UI.
