import { describe, it, expect } from "vitest";
import { createHarness } from "./harness";

const api = createHarness();

/**
 * Frontier query — the core of the product. These are the dedicated cases the
 * PRD calls out explicitly. The frontier = issues that are `todo` AND whose
 * every blocker is `done`.
 */
describe("GET /api/issues/frontier", () => {
  it("includes a todo issue with no blockers", async () => {
    const a = await api.createIssue({ title: "A", status: "todo" });
    const f = await api.frontier();
    expect(f.status).toBe(200);
    expect(f.body.map((i: any) => i.identifier)).toEqual(["FACT-1"]);
    void a;
  });

  it("includes a todo issue whose single blocker is done", async () => {
    const blocker = await api.createIssue({ title: "blocker", status: "todo" });
    const blocked = await api.createIssue({ title: "blocked", status: "todo" });
    // blocker blocks blocked
    await api.addBlocker(blocked.body.identifier, blocker.body.id);
    // mark blocker done
    await api.patchIssue(blocker.body.identifier, { status: "done" });
    const f = await api.frontier();
    const ids = f.body.map((i: any) => i.identifier);
    expect(ids).toContain(blocked.body.identifier);
  });

  it.each([
    ["backlog"],
    ["todo"],
    ["in_progress"],
    ["canceled"],
  ])(
    "excludes a todo issue whose single blocker is %s (only done satisfies)",
    async (status) => {
      const blocker = await api.createIssue({
        title: `blocker-${status}`,
        status: "todo",
      });
      const blocked = await api.createIssue({
        title: `blocked-${status}`,
        status: "todo",
      });
      await api.addBlocker(blocked.body.identifier, blocker.body.id);
      await api.patchIssue(blocker.body.identifier, { status });
      const f = await api.frontier();
      const ids = f.body.map((i: any) => i.identifier);
      expect(ids).not.toContain(blocked.body.identifier);
    },
  );

  it("includes a multi-blocker todo issue only when ALL blockers are done", async () => {
    const b1 = await api.createIssue({ title: "b1", status: "todo" });
    const b2 = await api.createIssue({ title: "b2", status: "todo" });
    const b3 = await api.createIssue({ title: "b3", status: "todo" });
    const target = await api.createIssue({ title: "target", status: "todo" });

    await api.addBlocker(target.body.identifier, b1.body.id);
    await api.addBlocker(target.body.identifier, b2.body.id);
    await api.addBlocker(target.body.identifier, b3.body.id);

    // None done -> not on frontier.
    let f = await api.frontier();
    expect(f.body.map((i: any) => i.identifier)).not.toContain(
      target.body.identifier,
    );

    // One done -> still blocked.
    await api.patchIssue(b1.body.identifier, { status: "done" });
    f = await api.frontier();
    expect(f.body.map((i: any) => i.identifier)).not.toContain(
      target.body.identifier,
    );

    // All done -> on frontier.
    await api.patchIssue(b2.body.identifier, { status: "done" });
    await api.patchIssue(b3.body.identifier, { status: "done" });
    f = await api.frontier();
    expect(f.body.map((i: any) => i.identifier)).toContain(
      target.body.identifier,
    );
  });

  it("never includes backlog / in_progress / done / canceled issues regardless of blockers", async () => {
    const back = await api.createIssue({ title: "backlog", status: "backlog" });
    const inprog = await api.createIssue({
      title: "inprog",
      status: "in_progress",
    });
    const done = await api.createIssue({ title: "done", status: "done" });
    const canc = await api.createIssue({
      title: "canceled",
      status: "canceled",
    });

    const f = await api.frontier();
    const ids = f.body.map((i: any) => i.identifier);
    expect(ids).not.toContain(back.body.identifier);
    expect(ids).not.toContain(inprog.body.identifier);
    expect(ids).not.toContain(done.body.identifier);
    expect(ids).not.toContain(canc.body.identifier);
  });

  it("orders by priority desc then created asc", async () => {
    // Create in deliberate priority/time order. Created asc means the older
    // issue at the same priority wins.
    const low = await api.createIssue({ title: "low", status: "todo", priority: 1 });
    const high = await api.createIssue({
      title: "high",
      status: "todo",
      priority: 3,
    });
    const med = await api.createIssue({ title: "med", status: "todo", priority: 2 });

    const f = await api.frontier();
    const ids: string[] = f.body.map((i: any) => i.identifier);
    // Other todo issues from earlier tests may be present; assert on the
    // relative ordering of our three specific issues rather than the full list.
    const iHigh = ids.indexOf(high.body.identifier);
    const iMed = ids.indexOf(med.body.identifier);
    const iLow = ids.indexOf(low.body.identifier);
    expect(iHigh).toBeLessThan(iMed);
    expect(iMed).toBeLessThan(iLow);
  });
});
