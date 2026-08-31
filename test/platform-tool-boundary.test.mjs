import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildPlatformCommandInput } from "../src/lib/runtime/platform-tool-broker-input.mjs";
import { validateOpenClawToolInput } from "../src/lib/runtime/openclaw-tool-input.mjs";

const plannerContext = { agentId: "11", runId: "22", ticketId: null };
const boundContext = { agentId: "11", runId: "22", ticketId: "33" };

test("FACT-43 OpenClaw policy allowlists set_ticket_dependencies", async () => {
  const policy = JSON.parse(await readFile("docker/openclaw/exec-approvals.json", "utf8"));
  const approval = policy.agents["*"].allowlist.find(
    (entry) => entry.pattern === "/app/bin/orbit-openclaw-tool.mjs",
  );
  assert.ok(approval);
  assert.match(approval.argPattern, /set_ticket_dependencies/);
  assert.match("set_ticket_dependencies {}", new RegExp(approval.argPattern));
});

test("FACT-43 wrapper permits only the planner dependency ticket target", () => {
  assert.doesNotThrow(() => validateOpenClawToolInput("set_ticket_dependencies", {
    ticketId: "44",
    blockerTicketIds: ["55"],
  }));
  assert.throws(
    () => validateOpenClawToolInput("update_ticket", { ticketId: "44" }),
    /ticketId is bound by the active dispatch/,
  );
  assert.throws(
    () => validateOpenClawToolInput("set_ticket_dependencies", { runId: "22" }),
    /runId is bound by the active dispatch/,
  );
});

test("FACT-43 broker preserves planner targets and forces bound targets", () => {
  assert.deepEqual(
    buildPlatformCommandInput(
      "set_ticket_dependencies",
      { ticketId: "44", blockerTicketIds: ["55"] },
      plannerContext,
      plannerContext,
    ),
    { ticketId: "44", blockerTicketIds: ["55"], agentId: "11", runId: "22" },
  );
  assert.deepEqual(
    buildPlatformCommandInput(
      "set_ticket_dependencies",
      { ticketId: "44", blockerTicketIds: ["55"] },
      boundContext,
      boundContext,
    ),
    { ticketId: "33", blockerTicketIds: ["55"], agentId: "11", runId: "22" },
  );
  assert.throws(
    () => buildPlatformCommandInput("update_ticket", {}, plannerContext, plannerContext),
    /update_ticket requires a ticket-bound dispatch/,
  );
});
