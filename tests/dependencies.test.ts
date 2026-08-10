import { describe, it, expect } from "vitest";
import { createHarness } from "./harness";

const api = createHarness();

/**
 * Dependency graph: blocker edges, cycle prevention, self-edge prevention,
 * and the blocker list reads. Direction is fixed: POST /blockers says
 * "blockerId blocks :id".
 */
describe("dependencies API", () => {
  it("adds and lists a blocker edge", async () => {
    const a = await api.createIssue({ title: "A" });
    const b = await api.createIssue({ title: "B" });
    const res = await api.addBlocker(b.body.identifier, a.body.id);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      blockerIssueId: a.body.id,
      blockedIssueId: b.body.id,
    });

    const blockers = await api.getBlockers(b.body.identifier);
    expect(blockers.status).toBe(200);
    expect(blockers.body.map((i: any) => i.identifier)).toEqual([
      a.body.identifier,
    ]);
  });

  it("rejects a self-edge with 400", async () => {
    const a = await api.createIssue({ title: "self" });
    const res = await api.addBlocker(a.body.identifier, a.body.id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("self_edge");
  });

  it("rejects a direct cycle (A blocks B, then B blocks A)", async () => {
    const a = await api.createIssue({ title: "A" });
    const b = await api.createIssue({ title: "B" });
    // A blocks B
    const r1 = await api.addBlocker(b.body.identifier, a.body.id);
    expect(r1.status).toBe(201);
    // Now B blocks A would create a cycle.
    const r2 = await api.addBlocker(a.body.identifier, b.body.id);
    expect(r2.status).toBe(400);
    expect(r2.body.error.code).toBe("cycle");
  });

  it("rejects a longer transitive cycle (A→B→C, then C→A)", async () => {
    const a = await api.createIssue({ title: "A" });
    const b = await api.createIssue({ title: "B" });
    const c = await api.createIssue({ title: "C" });
    // A blocks B, B blocks C
    expect((await api.addBlocker(b.body.identifier, a.body.id)).status).toBe(201);
    expect((await api.addBlocker(c.body.identifier, b.body.id)).status).toBe(201);
    // C blocks A would close the loop A→B→C→A.
    const res = await api.addBlocker(a.body.identifier, c.body.id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("cycle");
  });

  it("allows adding the same edge again idempotently (still 201)", async () => {
    const a = await api.createIssue({ title: "A" });
    const b = await api.createIssue({ title: "B" });
    const r1 = await api.addBlocker(b.body.identifier, a.body.id);
    expect(r1.status).toBe(201);
    // Duplicate edge: contract says 201 with the edge object.
    const r2 = await api.addBlocker(b.body.identifier, a.body.id);
    expect(r2.status).toBe(201);
    expect(r2.body).toEqual(r1.body);
  });

  it("removes a dependency edge with 204", async () => {
    const a = await api.createIssue({ title: "A" });
    const b = await api.createIssue({ title: "B" });
    await api.addBlocker(b.body.identifier, a.body.id);
    const res = await api.removeBlocker(b.body.identifier, String(a.body.id));
    expect(res.status).toBe(204);
    const blockers = await api.getBlockers(b.body.identifier);
    expect(blockers.body).toEqual([]);
  });

  it("returns 404 when deleting a missing edge", async () => {
    const a = await api.createIssue({ title: "A" });
    const b = await api.createIssue({ title: "B" });
    const res = await api.removeBlocker(b.body.identifier, String(a.body.id));
    expect(res.status).toBe(404);
  });

  it("returns 404 when either issue is missing on add", async () => {
    const a = await api.createIssue({ title: "A" });
    const res = await api.addBlocker(a.body.identifier, 999999);
    expect(res.status).toBe(404);
  });

  it("cascades: deleting a blocker issue removes its edges", async () => {
    const a = await api.createIssue({ title: "A" });
    const b = await api.createIssue({ title: "B" });
    await api.addBlocker(b.body.identifier, a.body.id);
    // Delete A; B should have no blockers now.
    await api.deleteIssue(a.body.identifier);
    const blockers = await api.getBlockers(b.body.identifier);
    expect(blockers.status).toBe(200);
    expect(blockers.body).toEqual([]);
  });
});
