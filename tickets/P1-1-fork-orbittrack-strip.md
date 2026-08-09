# P1-1 Fork OrbitTrack and strip unused features

**Phase:** 1 · **Tag:** [MUST] · **Depends:** Phase 0 gate passed

Fork OrbitTrack as the codebase foundation. Ticket schema, board UI, and branding are inherited. Unused routes/features must be **deleted, not left dormant** (PRD §1).

## Acceptance criteria

- [ ] Fork builds and runs locally.
- [ ] Every OrbitTrack route/feature not needed by OrbitFactory is removed (grep for dead routes, nav entries, components).
- [ ] Board UI and ticket schema still work after the strip.
- [ ] Short list in the PR description of what was removed (feeds the README's "adapted from OrbitTrack" note, P5-5).
