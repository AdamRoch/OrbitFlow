# FACT-41 Make dependencies and first assignment atomic per workflow run

**Priority:** High  
**Depends on:** None

## Outcome

Agents can replace a ticket's blocker set through one platform command. The
workflow engine dispatches only ready tickets and owns the only assignment path.
Graph edits and first assignment cannot race inside one run, while separate runs
continue independently.

## Scope

* Add `set_ticket_dependencies` to the closed platform tool surface.
* Treat the submitted blocker list as the complete desired set.
* Require every ticket to belong to the calling run and the same project.
* Reject duplicate blockers, self-dependencies, missing tickets, cycles, and
  changes after the blocked ticket leaves `todo`.
* Use the existing platform idempotency contract so a retry returns the same
  result.
* Return blocker ticket IDs from `list_tickets`.
* Serialize dependency replacement and first assignment on the workflow run,
  not the project. Use one clear lock order.
* Select only ready `todo` tickets for fan-out.
* In one transaction, verify readiness, create the first unique dispatch, move
  the ticket to `in_progress`, and set `assignee_agent_id`.
* Roll back the dispatch when guarded assignment loses a race.
* Touch the blocked ticket so the existing committed PostgreSQL notification
  wakes Monitoring after dependency changes.
* Register the command in every CLI, broker, runtime allowlist, usage surface,
  and current platform documentation.

## Ownership boundary

This ticket owns platform tools, workflow engine assignment, their focused
PostgreSQL tests, and related tool documentation. It does not rewrite the board
or packaging.

## Acceptance criteria

* [ ] Complete-set dependency replacement is same-run, same-project,
      idempotent, and cycle-safe.
* [ ] Two opposing graph updates cannot both commit a cycle.
* [ ] Dependency replacement racing first assignment has one valid winner and
      leaves no orphan dispatch.
* [ ] The engine never dispatches a blocked ticket.
* [ ] First dispatch moves one ticket to `in_progress` with its assignee in the
      same transaction.
* [ ] Separate workflow runs can update and assign tickets concurrently.
* [ ] PostgreSQL and pure engine tests pass.

## Verification

Run the platform tool proof, workflow engine proof, focused race tests, and the
credentialless application suite. Record the exact commands in the commit or
ticket result.
