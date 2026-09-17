# OrbitFlow rebuild

Adopted by Adam on 2026-09-06 for this isolated rebuild. The original repository remains read-only. Inherit active model settings; do not adopt historical model overrides.

## Product contract

Read PRODUCT.md and agent-factory-brief.md before choosing a vertical slice.
Read relevant accepted ADRs rather than importing every historical decision.

The central demo is a prompt producing a working application, followed by a
change request that produces an updated application. Preserve that outcome.
Every required agent setting must affect execution. Workflows, conditions, and
feedback routes must be editable. Real tools, durable messages, an inspectable
result, and Telegram conversation must be visible in the demo.

The old OrbitFlow repository is a source of lessons and selected components.
Its ticket model, service topology, migration history, and draft document-only
demo plan are not requirements for this repository.

## Execution

Use native tools and ordinary workspace documents. Use Lavish only when Adam
explicitly asks for it; do not start its review or polling workflow automatically.

Own the requested outcome through implementation, integration, and the agreed
verification. Resolve routine choices from the contract and code. Ask Adam only
when an unresolved decision changes scope or a required action lacks authorization.
Continue independent authorized work while a question is pending.

Implement useful vertical slices. Prefer deletion and direct code. Do not add a
framework, fallback path, deployment mode, or generic abstraction without a
concrete requirement. Keep the chosen coding runtime's responsibilities separate
from application state and workflow routing.

Keep one short WORK.md with the current slice, completed behavior, authorized
checks and their latest results, unresolved decisions, and next action. Update it
at meaningful handoffs. Do not build a separate project-management system to
coordinate this build. Record consequential design decisions in ADR/ and label
proposals clearly.

## Delegation during orchestrated implementation

When Adam requests orchestrated implementation, use available subagents for
independent, bounded tasks that improve delivery. The primary agent owns the
critical path, integration, and the final result. Do not delegate merely to fill
available slots or ask every worker to explore the whole repository.

Use at most three concurrent workers, or the smaller limit of the active harness.
Each assignment names its repository/worktree, outcome, permitted files,
dependencies, acceptance evidence, and external-action limits. Prefer a focused
context brief over copying the entire conversation. Workers report what changed,
what they checked, unresolved issues, and exact file or commit references.

Give overlapping edits to one owner. Use separate worktrees when independent
implementation branches need isolation; a worktree does not isolate running
processes, ports, databases, or secrets. The primary agent owns shared local
services and browser inspection. A worker returns a result rather than starting
an unattended advisor loop or spawning another coordination layer.

Use the configured model defaults unless the task needs a deliberate override.
Increase effort for difficult state, recovery, or review work. Preserve a model
Adam explicitly requests. Do not silently translate an unavailable model name.

Use native collaboration tools for this build. OrbitTrack ticket skills apply
only if Adam assigns tracker work and authorizes that integration.

## Verification policy

Adam explicitly authorized these checks in this repository, not in the original repository.

Name the relevant checks before running them. Add and run focused tests for agent
creation/configuration, workflow execution and feedback, and message delivery.
Cover concrete boundaries introduced by the slice, including tool authorization,
approval, cancellation, and generated-application isolation.

Run the affected package's typecheck/build when needed to establish that its
changed application path compiles and starts. Use an appropriate browser path
to verify a UI change. For prose or cosmetic changes, direct review is enough.
Do not add tests that repeat the implementation or run unrelated suites.

Fix failures caused by the current change. Report unrelated failures and continue
work that does not depend on them. Once relevant checks pass, repeat or broaden
them only for a new change, failure, or unresolved concern.

Adam's real end-to-end walkthrough remains the final product acceptance. Keep
local checks, model-backed runs, remote CI, and human acceptance distinct. Never
present a stubbed runtime or a successful build as proof of the real demo.

## External boundaries

Preparing code or accepting this architecture does not authorize new provider
spending, remote pushes, publication, deployment, merges, or production changes.
Follow Adam's explicit authorization for each of those actions. Honor an already
approved provider budget without repeatedly asking; stop paid work at its limit.

Keep generated application code in the agreed execution boundary. It must not
inherit the host's credentials or execute on the developer's host by default.
Do not bypass that boundary to get an impressive screenshot.

Preserve user work and existing deployments. No automatic migration, data deletion,
old-worktree cleanup, or bot cutover belongs to the rebuild's implicit scope.
