import { describe, it, expect } from "vitest";
import { createHarness } from "./harness";

const api = createHarness();

/**
 * UI smoke tests. The PRD only requires "a couple of smoke checks that pages
 * render with expected elements" — the data correctness is covered at the API.
 * These fetch the HTML and assert key elements are present.
 */
describe("UI smoke", () => {
  it("list page renders with nav, filter bar, and empty state", async () => {
    // Seed a label so the filter options aren't empty.
    await api.createLabel({ name: "smoke-label", color: "#22c55e" });

    const res = await api.fetch("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/OrbitFactory/);
    expect(html).toMatch(/Tickets/);
    expect(html).toMatch(/New/);
    // Filter controls present: the status dropdown (with hover quick picks
    // for To do / In progress) plus priority/label selects.
    expect(html).toMatch(/In progress/);
    expect(html).toMatch(/>Status<\/label>/);
    // Keyboard-shortcut cheat sheet is rendered.
    expect(html).toMatch(/Status shortcuts/);
    expect(html).toMatch(/aria-label="Keyboard shortcuts"/);
    // The seeded label appears as a filter option.
    expect(html).toMatch(/smoke-label/);
    expect(html).not.toMatch(/href="\/map"/);
    expect(html).not.toMatch(/>Project<\/label>/);
  });

  it("list page defaults to todo tickets and toggles to in progress", async () => {
    await api.createIssue({ title: "Smoke todo only", status: "todo" });
    const wip = await api.createIssue({
      title: "Smoke wip only",
      status: "todo",
    });
    expect(wip.status).toBe(201);
    const claimed = await api.claim(wip.body.identifier);
    expect(claimed.status).toBe(200);

    // Default view: To Do only.
    const def = await api.fetch("/");
    const defHtml = await def.text();
    expect(defHtml).toMatch(/Smoke todo only/);
    expect(defHtml).not.toMatch(/Smoke wip only/);

    // ?status=in_progress (what the toggle button navigates to): the reverse.
    const prog = await api.fetch("/?status=in_progress");
    const progHtml = await prog.text();
    expect(progHtml).toMatch(/Smoke wip only/);
    expect(progHtml).not.toMatch(/Smoke todo only/);

    // ?status=all (the dropdown's "Any"): no status filter, both show.
    const all = await api.fetch("/?status=all");
    const allHtml = await all.text();
    expect(allHtml).toMatch(/Smoke wip only/);
    expect(allHtml).toMatch(/Smoke todo only/);
  });

  it("detail page renders title, status, description, and dependency sections", async () => {
    const created = await api.createIssue({
      title: "Smoke detail",
      description: "## Heading\n\nbody text",
      status: "todo",
    });
    const res = await api.fetch(`/issues/${created.body.identifier}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Smoke detail/);
    expect(html).toMatch(new RegExp(created.body.identifier));
    // Rendered markdown (h2 from "## Heading").
    expect(html).toMatch(/<h2>Heading<\/h2>/);
    // Dependency sections present.
    expect(html).toMatch(/Blocked by|Blockers/);
    expect(html).toMatch(/Blocks/);
    // Edit/claim affordances.
    expect(html).toMatch(/Edit/);
  });

  it("new-issue page renders the create form", async () => {
    const res = await api.fetch("/new");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/New ticket/);
    expect(html).not.toMatch(/name="projectKey"/);
    expect(html).toMatch(/name="title"/);
    expect(html).toMatch(/name="description"/);
    expect(html).toMatch(/name="status"/);
    expect(html).toMatch(/name="priority"/);
  });

  it("frontier page renders the frontier explainer", async () => {
    const res = await api.fetch("/frontier");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Frontier/);
    expect(html).toMatch(/\/api\/issues\/frontier/);
  });

  it("missing issue detail returns 404", async () => {
    const res = await api.fetch("/issues/FACT-88888");
    expect(res.status).toBe(404);
  });
});
