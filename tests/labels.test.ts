import { describe, it, expect } from "vitest";
import { createHarness } from "./harness";

const api = createHarness();

/**
 * Labels: CRUD, the PUT full-replacement contract (unknown names = 400), and
 * the cascade behavior on label delete.
 */
describe("labels API", () => {
  describe("POST /api/labels", () => {
    it("creates a label", async () => {
      const res = await api.createLabel({ name: "feature", color: "#3b82f6" });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("feature");
      expect(res.body.color).toBe("#3b82f6");
      expect(typeof res.body.id).toBe("number");
    });

    it("defaults the color when omitted", async () => {
      const res = await api.createLabel({ name: "nocolor" });
      expect(res.status).toBe(201);
      expect(res.body.color).toMatch(/^#/);
    });

    it("rejects an empty name with 400", async () => {
      const res = await api.createLabel({ name: "  " });
      expect(res.status).toBe(400);
    });

    it("rejects an invalid color with 400", async () => {
      const res = await api.createLabel({ name: "badcolor", color: "red" });
      expect(res.status).toBe(400);
    });

    it("rejects a duplicate name with 400", async () => {
      await api.createLabel({ name: "dupe", color: "#000000" });
      const res = await api.createLabel({ name: "dupe", color: "#111111" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("duplicate");
    });
  });

  describe("GET /api/labels", () => {
    it("lists labels sorted by name", async () => {
      await api.createLabel({ name: "zebra", color: "#000000" });
      await api.createLabel({ name: "alpha", color: "#000000" });
      const res = await api.listLabels();
      expect(res.status).toBe(200);
      const names = res.body.map((l: any) => l.name);
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
    });
  });

  describe("PUT /api/issues/:id/labels (full replacement)", () => {
    it("replaces the label set with the provided names", async () => {
      await api.createLabel({ name: "a1", color: "#000000" });
      await api.createLabel({ name: "b2", color: "#000000" });
      await api.createLabel({ name: "c3", color: "#000000" });
      const issue = await api.createIssue({ title: "x", labelNames: ["a1"] });
      expect(issue.body.labels.map((l: any) => l.name)).toEqual(["a1"]);

      const res = await api.setLabels(issue.body.identifier, ["b2", "c3"]);
      expect(res.status).toBe(200);
      expect(res.body.labels.map((l: any) => l.name).sort()).toEqual([
        "b2",
        "c3",
      ]);

      // Re-read to confirm persistence.
      const after = await api.getIssue(issue.body.identifier);
      expect(after.body.labels.map((l: any) => l.name).sort()).toEqual([
        "b2",
        "c3",
      ]);
    });

    it("returns 400 for an unknown label name", async () => {
      const issue = await api.createIssue({ title: "x" });
      const res = await api.setLabels(issue.body.identifier, ["nonexistent"]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("unknown_label");
    });

    it("returns 404 when the issue is missing", async () => {
      const res = await api.setLabels("FACT-99999", []);
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/labels/:id (cascade)", () => {
    it("removes the label from all issues but keeps the issues", async () => {
      await api.createLabel({ name: "shared", color: "#22c55e" });
      const i1 = await api.createIssue({ title: "one", labelNames: ["shared"] });
      const i2 = await api.createIssue({ title: "two", labelNames: ["shared"] });

      const labelId = i1.body.labels[0].id;
      const res = await api.deleteLabel(labelId);
      expect(res.status).toBe(204);

      // Issues still exist, but no longer carry the label.
      const a1 = await api.getIssue(i1.body.identifier);
      const a2 = await api.getIssue(i2.body.identifier);
      expect(a1.status).toBe(200);
      expect(a2.status).toBe(200);
      expect(a1.body.labels).toEqual([]);
      expect(a2.body.labels).toEqual([]);
    });

    it("returns 404 for a missing label", async () => {
      const res = await api.deleteLabel(999999);
      expect(res.status).toBe(404);
    });
  });
});
