# P0-3 Spike: headless coding CLI wrapper → pick v1 CodingToolAdapter

**Phase:** 0 · **Tag:** [CORE] · **Depends:** —

Wrap the candidate headless coding CLI: submit a task against a workspace, get back a diff, log, and usage. The result decides which CLI ships as the one v1 `CodingToolAdapter` implementation (PRD §5).

## Constraints

- Must authenticate via a single env-var API key — an evaluator's `docker compose up` has to work with no interactive login.

## Acceptance criteria

- [ ] `delegate_coding_task(task, workspace)` shape proven: task in → `{diff, log, usage}` out.
- [ ] Runs fully headless (no TTY, no interactive prompts).
- [ ] Auth works from a single env var.
- [ ] Decision recorded: which CLI is v1, and why.
