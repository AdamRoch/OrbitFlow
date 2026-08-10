import { describe, it, expect } from "vitest";
import { createHarness } from "./harness";

const api = createHarness();

/**
 * The "Ready for Agent" label is derived from issue state, not stored. It is
 * present (and `ready === true`) exactly when an issue is on the frontier:
 * status `todo` and every blocker `done`. It's never persisted in
 * `issue_labels`, so it can't be assigned, created, or deleted by name.
 *
 * These tests pin that contract.
 */
describe("derived 'Ready for Agent' label", () => {
  describe("ready flag + virtual label", () => {
    it("is ready (and carries the label) for a todo issue with no blockers", async () => {
      const a = await api.createIssue({ title: "free", status: "todo" });
      const res = await api.getIssue(a.body.identifier);
      expect(res.body.ready).toBe(true);
      expect(res.body.labels.map((l: any) => l.name)).toContain(
        "ready-for-agent",
      );
    });

    it("is not ready for a backlog issue, and carries no label", async () => {
      const a = await api.createIssue({ title: "backlog", status: "backlog" });
      const res = await api.getIssue(a.body.identifier);
      expect(res.body.ready).toBe(false);
      expect(res.body.labels.map((l: any) => l.name)).not.toContain(
        "ready-for-agent",
      );
    });

    it("is not ready when blocked by an unfinished blocker (no label)", async () => {
      const blocker = await api.createIssue({ title: "b", status: "todo" });
      const blocked = await api.createIssue({ title: "blocked", status: "todo" });
      await api.addBlocker(blocked.body.identifier, blocker.body.id);
      const res = await api.getIssue(blocked.body.identifier);
      expect(res.body.ready).toBe(false);
      expect(res.body.labels.map((l: any) => l.name)).not.toContain(
        "ready-for-agent",
      );
    });

    it("becomes ready once the sole blocker is done", async () => {
      const blocker = await api.createIssue({ title: "b", status: "todo" });
      const blocked = await api.createIssue({ title: "blocked", status: "todo" });
      await api.addBlocker(blocked.body.identifier, blocker.body.id);
      await api.patchIssue(blocker.body.identifier, { status: "done" });
      const res = await api.getIssue(blocked.body.identifier);
      expect(res.body.ready).toBe(true);
      expect(res.body.labels.map((l: any) => l.name)).toContain(
        "ready-for-agent",
      );
    });

    it("treats a canceled blocker as not satisfying the edge", async () => {
      const blocker = await api.createIssue({ title: "b", status: "todo" });
      const blocked = await api.createIssue({ title: "blocked", status: "todo" });
      await api.addBlocker(blocked.body.identifier, blocker.body.id);
      await api.patchIssue(blocker.body.identifier, { status: "canceled" });
      const res = await api.getIssue(blocked.body.identifier);
      expect(res.body.ready).toBe(false);
    });
  });

  describe("cannot be assigned by name", () => {
    it("is a no-op when passed to setLabels (kept off, since not ready)", async () => {
      const a = await api.createIssue({ title: "x", status: "backlog" });
      const res = await api.setLabels(a.body.identifier, [
        "ready-for-agent",
      ]);
      expect(res.status).toBe(200);
      // The label is derived: a backlog issue isn't ready, so it must not appear.
      expect(res.body.labels.map((l: any) => l.name)).not.toContain(
        "ready-for-agent",
      );
    });

    it("is ignored on create, and only appears once the issue is ready", async () => {
      const a = await api.createIssue({
        title: "y",
        status: "todo",
        labelNames: ["ready-for-agent"],
      });
      expect(a.status).toBe(201);
      // A todo issue with no blockers IS ready, so the label shows up.
      expect(a.body.ready).toBe(true);
      expect(a.body.labels.map((l: any) => l.name)).toContain(
        "ready-for-agent",
      );
    });
  });

  describe("cannot be created as a stored label", () => {
    it("rejects creating the reserved name with 400", async () => {
      const res = await api.createLabel({
        name: "ready-for-agent",
        color: "#22c55e",
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("reserved");
    });

    it("rejects the reserved name case-insensitively", async () => {
      const res = await api.createLabel({
        name: "Ready-For-Agent",
        color: "#22c55e",
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("reserved");
    });
  });

  describe("GET /api/issues?label=ready-for-agent (derived filter)", () => {
    it("returns only ready issues (todo + all blockers done)", async () => {
      const ready = await api.createIssue({
        title: "ready-one",
        status: "todo",
      });
      const blocker = await api.createIssue({ title: "blk", status: "todo" });
      const blocked = await api.createIssue({
        title: "blocked-one",
        status: "todo",
      });
      await api.addBlocker(blocked.body.identifier, blocker.body.id);

      const res = await api.listIssues("?label=ready-for-agent");
      const ids = res.body.map((i: any) => i.identifier);
      expect(ids).toContain(ready.body.identifier);
      expect(ids).not.toContain(blocked.body.identifier);
    });
  });
});
