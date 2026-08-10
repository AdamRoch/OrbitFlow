import { describe, it, expect } from "vitest";
import { createHarness } from "./harness";

const api = createHarness();

/**
 * Issues CRUD + list filtering + the canonical JSON shape.
 */
describe("issues API", () => {
  describe("POST /api/issues", () => {
    it("creates an issue with defaults (status backlog, priority 0)", async () => {
      const res = await api.createIssue({ title: "First" });
      expect(res.status).toBe(201);
      const issue = res.body;
      expect(issue.identifier).toMatch(/^FACT-\d+$/);
      expect(issue.number).toBeGreaterThan(0);
      expect(issue.title).toBe("First");
      expect(issue.description).toBeNull();
      expect(issue.status).toBe("backlog");
      expect(issue.priority).toBe(0);
      expect(issue.labels).toEqual([]);
      expect(issue.blockerIssueIds).toEqual([]);
      expect(issue.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(issue.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("accepts description, status, priority", async () => {
      const res = await api.createIssue({
        title: "With fields",
        description: "Some **markdown**",
        status: "todo",
        priority: 3,
      });
      expect(res.status).toBe(201);
      expect(res.body.description).toBe("Some **markdown**");
      expect(res.body.status).toBe("todo");
      expect(res.body.priority).toBe(3);
    });

    it("returns 400 when title is missing", async () => {
      const res = await api.createIssue({ description: "no title" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toMatch(/title/i);
    });

    it("returns 400 when title is empty/whitespace", async () => {
      const res = await api.createIssue({ title: "   " });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/title/i);
    });

    it("returns 400 on an invalid status enum", async () => {
      const res = await api.createIssue({ title: "x", status: "weird" });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/status/i);
    });

    it("returns 400 on an invalid priority", async () => {
      const res = await api.createIssue({ title: "x", priority: 7 });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/priority/i);
    });

    it("attaches existing labels by name on creation (case-insensitive)", async () => {
      await api.createLabel({ name: "ui", color: "#22c55e" });
      const res = await api.createIssue({
        title: "labeled",
        labelNames: ["UI"],
      });
      expect(res.status).toBe(201);
      // The persisted label is attached; "ready-for-agent" is derived so it
      // does NOT appear here (the issue is backlog, not ready).
      expect(res.body.labels.map((l: any) => l.name)).toEqual(["ui"]);
    });
  });

  describe("GET /api/issues/:id", () => {
    it("returns 404 for a missing issue (numeric id)", async () => {
      const res = await api.getIssue("9999999");
      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });

    it("resolves by identifier (FACT-N) and by numeric id", async () => {
      const created = await api.createIssue({ title: "lookup me" });
      const byId = await api.getIssue(String(created.body.id));
      const byIdent = await api.getIssue(created.body.identifier);
      expect(byId.status).toBe(200);
      expect(byIdent.status).toBe(200);
      expect(byId.body.id).toBe(byIdent.body.id);
    });

    it("returns the canonical shape", async () => {
      const created = await api.createIssue({ title: "shape" });
      const res = await api.getIssue(created.body.identifier);
      const keys = Object.keys(res.body).sort();
      expect(keys).toEqual(
        [
          "blockerIssueIds",
          "createdAt",
          "description",
          "id",
          "identifier",
          "labels",
          "number",
          "priority",
          "ready",
          "status",
          "title",
          "updatedAt",
        ].sort(),
      );
    });
  });

  describe("PATCH /api/issues/:id", () => {
    it("updates provided fields only", async () => {
      const created = await api.createIssue({
        title: "orig",
        description: "orig desc",
      });
      const res = await api.patchIssue(created.body.identifier, {
        title: "new title",
        status: "in_progress",
      });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe("new title");
      expect(res.body.status).toBe("in_progress");
      // untouched fields preserved
      expect(res.body.description).toBe("orig desc");
    });

    it("bumps updatedAt on change", async () => {
      const created = await api.createIssue({ title: "time" });
      await new Promise((r) => setTimeout(r, 20));
      const res = await api.patchIssue(created.body.identifier, {
        title: "time2",
      });
      expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(
        new Date(created.body.updatedAt).getTime(),
      );
    });

    it("returns 404 for a missing issue", async () => {
      const res = await api.patchIssue("FACT-99999", { title: "x" });
      expect(res.status).toBe(404);
    });

    it("returns 400 on an invalid enum", async () => {
      const created = await api.createIssue({ title: "x" });
      const res = await api.patchIssue(created.body.identifier, {
        status: "nope",
      });
      expect(res.status).toBe(400);
    });

    it("can clear the description by setting it to null or empty", async () => {
      const created = await api.createIssue({
        title: "x",
        description: "has desc",
      });
      const res = await api.patchIssue(created.body.identifier, {
        description: null,
      });
      expect(res.status).toBe(200);
      expect(res.body.description).toBeNull();
    });
  });

  describe("DELETE /api/issues/:id", () => {
    it("removes the issue and returns 204", async () => {
      const created = await api.createIssue({ title: "gone" });
      const res = await api.deleteIssue(created.body.identifier);
      expect(res.status).toBe(204);
      const after = await api.getIssue(created.body.identifier);
      expect(after.status).toBe(404);
    });

    it("returns 404 when deleting a missing issue", async () => {
      const res = await api.deleteIssue("FACT-77777");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/issues (list + filters)", () => {
    it("returns all issues sorted by priority desc then created desc", async () => {
      await api.createIssue({ title: "p1", priority: 1 });
      await api.createIssue({ title: "p3", priority: 3 });
      await api.createIssue({ title: "p2", priority: 2 });
      const res = await api.listIssues();
      expect(res.status).toBe(200);
      const priorities = res.body.map((i: any) => i.priority);
      // Descending
      for (let i = 1; i < priorities.length; i++) {
        expect(priorities[i - 1]).toBeGreaterThanOrEqual(priorities[i]);
      }
    });

    it("filters by status", async () => {
      const a = await api.createIssue({ title: "a", status: "todo" });
      await api.createIssue({ title: "b", status: "backlog" });
      const res = await api.listIssues("?status=todo");
      const ids = res.body.map((i: any) => i.identifier);
      expect(ids).toContain(a.body.identifier);
      expect(res.body.every((i: any) => i.status === "todo")).toBe(true);
    });

    it("filters by priority", async () => {
      const a = await api.createIssue({ title: "hi", priority: 4 });
      await api.createIssue({ title: "lo", priority: 0 });
      const res = await api.listIssues("?priority=4");
      const ids = res.body.map((i: any) => i.identifier);
      expect(ids).toContain(a.body.identifier);
      expect(res.body.every((i: any) => i.priority === 4)).toBe(true);
    });

    it("filters by label name", async () => {
      await api.createLabel({ name: "bug", color: "#ef4444" });
      const labeled = await api.createIssue({
        title: "bugged",
        labelNames: ["bug"],
      });
      await api.createIssue({ title: "plain" });
      const res = await api.listIssues("?label=bug");
      const ids = res.body.map((i: any) => i.identifier);
      expect(ids).toContain(labeled.body.identifier);
      expect(res.body.every((i: any) =>
        i.labels.some((l: any) => l.name === "bug"),
      )).toBe(true);
    });
  });
});
