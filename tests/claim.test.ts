import { describe, it, expect } from "vitest";
import { createHarness } from "./harness";

const api = createHarness();

/**
 * claim is the only conditional status transition and is load-bearing for
 * agent loops. todo → in_progress succeeds; in_progress is idempotent; every
 * other status yields 409.
 */
describe("POST /api/issues/:id/claim", () => {
  it("moves a todo issue to in_progress", async () => {
    const created = await api.createIssue({ title: "claim me", status: "todo" });
    const res = await api.claim(created.body.identifier);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
  });

  it("is idempotent when already in_progress", async () => {
    const created = await api.createIssue({ title: "again", status: "todo" });
    const first = await api.claim(created.body.identifier);
    expect(first.status).toBe(200);
    const second = await api.claim(created.body.identifier);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("in_progress");
  });

  it.each(["backlog", "done", "canceled"] as const)(
    "returns 409 when status is %s",
    async (status) => {
      const created = await api.createIssue({
        title: `from-${status}`,
        status,
      });
      const res = await api.claim(created.body.identifier);
      expect(res.status).toBe(409);
      expect(res.body.error).toBeDefined();
    },
  );

  it("returns 409 when the issue has an undone blocker", async () => {
    const blocker = await api.createIssue({ title: "blocker", status: "todo" });
    const blocked = await api.createIssue({ title: "blocked", status: "todo" });
    await api.addBlocker(blocked.body.identifier, blocker.body.id);
    const res = await api.claim(blocked.body.identifier);
    expect(res.status).toBe(409);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("blocked");
  });

  it("returns 404 for a missing issue", async () => {
    const res = await api.claim("FACT-99999");
    expect(res.status).toBe(404);
  });
});
