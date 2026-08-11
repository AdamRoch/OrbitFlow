import { describe, expect, it } from "vitest";
import { parseAgentGuardrails, parseRunCostLimit } from "../src/lib/guardrails";

describe("parseAgentGuardrails", () => {
  it("returns empty guardrails for missing or malformed containers", () => {
    for (const value of [undefined, null, "nope", 7, [1, 2]]) {
      expect(parseAgentGuardrails(value)).toEqual({
        costLimit: null,
        rateLimitPerMinute: null,
        blockedActions: [],
      });
    }
  });

  it("parses the editor-owned guardrail shape", () => {
    expect(
      parseAgentGuardrails({
        costLimit: 12.5,
        rateLimit: { perMinute: 8 },
        blockedActions: ["create_ticket", "post_message"],
      }),
    ).toEqual({ costLimit: 12.5, rateLimitPerMinute: 8, blockedActions: ["create_ticket", "post_message"] });
  });

  it("keeps zero as a configured value", () => {
    expect(parseAgentGuardrails({ costLimit: 0, rateLimit: { perMinute: 0 } })).toEqual({
      costLimit: 0,
      rateLimitPerMinute: 0,
      blockedActions: [],
    });
  });

  it("fails open on malformed fields", () => {
    expect(
      parseAgentGuardrails({
        costLimit: "lots",
        rateLimit: { perMinute: -3 },
        blockedActions: ["create_ticket", 7, "", "  "],
      }),
    ).toEqual({ costLimit: null, rateLimitPerMinute: null, blockedActions: ["create_ticket"] });
  });
});

describe("parseRunCostLimit", () => {
  it("reads the run ceiling from spec.guardrails.costLimit", () => {
    expect(parseRunCostLimit({ objective: "x", guardrails: { costLimit: 0.5 } })).toBe(0.5);
  });

  it("returns null without a valid ceiling", () => {
    expect(parseRunCostLimit({})).toBeNull();
    expect(parseRunCostLimit({ guardrails: { costLimit: -1 } })).toBeNull();
    expect(parseRunCostLimit({ guardrails: "nope" })).toBeNull();
    expect(parseRunCostLimit(null)).toBeNull();
    expect(parseRunCostLimit("nope")).toBeNull();
  });
});
