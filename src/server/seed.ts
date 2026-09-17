import { query } from "./db.js";
import type { Agent, Workflow } from "../shared/types.js";
export const defaultAgent = (
  id: string,
  name: string,
  role: string,
  prompt: string,
): Agent => ({
  id,
  name,
  role,
  systemPrompt: prompt,
  model: (role === "Reviewer" ? process.env.ORBITFLOW_REVIEWER_MODEL : undefined) ?? process.env.ORBITFLOW_MODEL ?? "anthropic/claude-sonnet-4-5",
  tools:
    role === "Reviewer"
      ? ["read", "glob", "grep"]
      : ["read", "write", "edit", "glob", "grep"],
  memory: [],
  skills: [
    {
      name: role === "Reviewer" ? "Review a browser application" : "Browser application",
      steps: role === "Reviewer" ? [
        "Read the supplied source once. For a revision, inspect only the changed behavior and directly affected code.",
        "Use no more than six read/search calls to decide whether the requested change and persistence are correct. Avoid exhaustive searches for speculative issues.",
        "Return approved or actionable revision feedback promptly. Distinguish source review from browser testing.",
      ] : [
        "Use plain HTML, CSS and JavaScript with no external packages or network dependencies.",
        "Implement real interactions and use localStorage for persistence.",
        "Retain index.html at the workspace root.",
      ],
    },
  ],
  approval: "publish",
  guardrails: {
    maxCostUsd: 2,
    maxTurns: 8,
    callsPerHour: 30,
    blockedActions: [],
  },
  schedule: {
    enabled: false,
    expression: "@every 1h",
    prompt: "",
    workflowId: null,
  },
  telegram: false,
});
export async function seed() {
  const agents = [
    defaultAgent(
      "builder",
      "Builder",
      "Builder",
      "Build or improve the requested browser application using native file tools. Incorporate reviewer feedback. Return outcome review and a concise summary of the work.",
    ),
    defaultAgent(
      "reviewer",
      "Reviewer",
      "Reviewer",
      "Read the application source using tools. Check the requested behaviors, accessibility and persistence. Return outcome approved if it meets the request, otherwise revise with specific actionable feedback. Do not claim browser testing you did not perform.",
    ),
  ];
  agents.push(
    defaultAgent(
      "improver",
      "Improver",
      "Builder",
      "Improve the supplied existing browser application to satisfy the change request using native file tools. Preserve existing features and localStorage keys so saved data survives. Incorporate reviewer feedback. Return outcome review and a concise summary.",
    ),
    defaultAgent(
      "regression-reviewer",
      "Regression Reviewer",
      "Reviewer",
      "Read the supplied application and its requested change using native tools. Review preserved behavior, persistence compatibility, and the new interactions. Return approved if requirements are met; otherwise return revise with actionable feedback. Do not claim browser testing you did not perform.",
    ),
  );
  for (const a of agents)
    await query(
      "INSERT INTO agents(id,data) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [a.id, a],
    );
  for (const [id, name, description] of [
    [
      "build",
      "Build an application",
      "Turn a request into a persistent browser app, review it, and approve its preview.",
    ],
    [
      "improve",
      "Improve an application",
      "Start from an approved application and make a reviewed change.",
    ],
  ]) {
    const w: Workflow = {
      id,
      name,
      description,
      requiresSource: id === "improve",
      entryNode: "build",
      nodes: [
        {
          id: "build",
          agentId: id === "improve" ? "improver" : "builder",
          label: id === "improve" ? "Improve" : "Build",
          x: 80,
          y: 100,
          terminalOutcomes: [],
        },
        {
          id: "review",
          agentId: id === "improve" ? "regression-reviewer" : "reviewer",
          label: id === "improve" ? "Regression review" : "Review",
          x: 400,
          y: 100,
          terminalOutcomes: ["approved"],
        },
      ],
      edges: [
        { id: "handoff", from: "build", to: "review", outcome: "review" },
        { id: "revision", from: "review", to: "build", outcome: "revise" },
      ],
    };
    await query(
      "INSERT INTO workflows(id,data,template) VALUES($1,$2,true) ON CONFLICT DO NOTHING",
      [id, w],
    );
  }
}
