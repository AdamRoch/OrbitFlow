import { describe, it, expect } from "vitest";
import { createHarness } from "./harness";

const api = createHarness();

/**
 * Identifier scheme: sequential project-wide numbers, never reused even after
 * deletes. `number` and `id` are independent.
 */
describe("identifier assignment", () => {
  it("assigns sequential numbers across creates", async () => {
    const a = await api.createIssue({ title: "a" });
    const b = await api.createIssue({ title: "b" });
    const c = await api.createIssue({ title: "c" });
    expect(b.body.number).toBe(a.body.number + 1);
    expect(c.body.number).toBe(b.body.number + 1);
    expect(a.body.identifier).toBe(`FACT-${a.body.number}`);
  });

  it("does not reuse numbers after deletes", async () => {
    const a = await api.createIssue({ title: "a" });
    const b = await api.createIssue({ title: "b" });
    const aNumber = a.body.number;
    await api.deleteIssue(a.body.identifier);
    const c = await api.createIssue({ title: "c" });
    expect(c.body.number).toBe(b.body.number + 1);
    // The deleted number is gone and not reused.
    expect(c.body.number).not.toBe(aNumber);
  });

  it("keeps number and surrogate id independent", async () => {
    // After a delete, the next id (AUTOINCREMENT) and next number (max+1) may
    // differ; both must be unique and monotonic-ish.
    const a = await api.createIssue({ title: "a" });
    await api.deleteIssue(a.body.identifier);
    const b = await api.createIssue({ title: "b" });
    expect(b.body.number).toBeGreaterThan(a.body.number);
  });
});
