import { z } from "zod";
export const agentSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(100),
  role: z.string().max(300),
  systemPrompt: z.string().max(20000),
  model: z.string().min(1).max(200),
  tools: z.array(z.enum(["read", "write", "edit", "glob", "grep"])).max(5),
  memory: z.array(z.string().max(4000)).max(100),
  skills: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        steps: z.array(z.string().max(4000)).max(50),
      }),
    )
    .max(50),
  approval: z.enum(["always", "publish", "never"]),
  guardrails: z.object({
    maxCostUsd: z.number().positive().max(1000),
    maxTurns: z.number().int().min(1).max(30),
    callsPerHour: z.number().int().min(1).max(1000),
    blockedActions: z
      .array(z.enum(["read", "write", "edit", "glob", "grep"]))
      .max(5),
  }),
  schedule: z.object({
    enabled: z.boolean(),
    expression: z.string().max(100),
    prompt: z.string().max(10000),
    workflowId: z.string().nullable(),
  }),
  telegram: z.boolean(),
});
export const workflowSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().min(1).max(100),
    description: z.string().max(1000),
    entryNode: z.string().min(1),
    requiresSource: z.boolean().optional(),
    nodes: z
      .array(
        z.object({
          id: z.string().min(1),
          agentId: z.string().min(1),
          label: z.string().max(100),
          x: z.number().finite(),
          y: z.number().finite(),
          terminalOutcomes: z
            .array(z.string().trim().min(1).max(100))
            .max(20)
            .default([]),
        }),
      )
      .min(1)
      .max(30),
    edges: z
      .array(
        z.object({
          id: z.string().min(1),
          from: z.string(),
          to: z.string(),
          outcome: z.string().min(1).max(100),
        }),
      )
      .max(100),
  })
  .superRefine((w, c) => {
    const ids = new Set(w.nodes.map((n) => n.id));
    if (ids.size !== w.nodes.length || !ids.has(w.entryNode))
      c.addIssue({
        code: "custom",
        message: "Node IDs must be unique and entry must exist",
      });
    const routes = new Set<string>();
    for (const e of w.edges) {
      const key = e.from + "\0" + e.outcome;
      if (!ids.has(e.from) || !ids.has(e.to) || routes.has(key))
        c.addIssue({
          code: "custom",
          message:
            "Edges must reference nodes and have unique outcomes per source",
        });
      routes.add(key);
    }
    for (const node of w.nodes) {
      const outcomes = new Set(node.terminalOutcomes);
      if (
        outcomes.size === 0 &&
        !w.edges.some((edge) => edge.from === node.id)
      )
        c.addIssue({
          code: "custom",
          message: "Each node needs a routed or terminal outcome",
        });
      if (outcomes.size !== node.terminalOutcomes.length)
        c.addIssue({
          code: "custom",
          message: "Terminal outcomes must be unique per node",
        });
      for (const outcome of outcomes)
        if (routes.has(node.id + "\0" + outcome))
          c.addIssue({
            code: "custom",
            message: "An outcome cannot both route and finish the same node",
          });
    }
  });
export function effectiveTools(agent: {
  tools: string[];
  guardrails: { blockedActions: string[] };
}) {
  return agent.tools.filter(
    (t) => !agent.guardrails.blockedActions.includes(t),
  );
}
