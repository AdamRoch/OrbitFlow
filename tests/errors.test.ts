import { describe, it, expect } from "vitest";
import { createHarness } from "./harness";

const api = createHarness();

/**
 * The canonical error shape: every 4xx/5xx is
 *   { error: { message: string, code: string | null } }
 */
describe("error envelope", () => {
  it("404 returns the canonical error shape", async () => {
    const res = await api.getIssue("FACT-99998");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { message: expect.any(String), code: "not_found" },
    });
  });

  it("400 returns the canonical error shape", async () => {
    const res = await api.createIssue({ title: "" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { message: expect.any(String), code: expect.any(String) },
    });
  });

  it("409 returns the canonical error shape", async () => {
    const created = await api.createIssue({ title: "x", status: "backlog" });
    const res = await api.claim(created.body.identifier);
    expect(res.status).toBe(409);
    expect(res.body.error).toBeDefined();
    expect(typeof res.body.error.message).toBe("string");
    expect(res.body.error.code).toBe("not_claimable");
  });

  it("rejects malformed JSON body with 400", async () => {
    const res = await api.fetch("/api/issues", {
      method: "POST",
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});
