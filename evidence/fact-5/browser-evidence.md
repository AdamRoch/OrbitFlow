# FACT-5 browser evidence

Captured with `chrome-devtools-axi` against the live Next.js application at
`http://127.0.0.1:3105` on 2026-08-10.

## Desktop

- The board rendered the `OrbitFactory` application title and only Tickets,
  Frontier, Labels, and New navigation entries.
- Ticket `FACT-1` was created through `/new`, opened at
  `/issues/FACT-1`, and renamed through the hydrated edit form.
- The `feature` label selected during creation persisted on the detail page.
- `FACT-2` was added as a blocker through the detail UI. The board then showed
  `FACT-1` as Blocked.
- The frontier page listed only ready ticket `FACT-2`; blocked `FACT-1` was
  absent.
- A `workflow` label was created through `/labels` and returned by
  `GET /api/labels`.

The retained evidence is the semantic browser snapshot summarized here; the
screenshot command reported a path but did not persist a file in this runner.

## Narrow viewport

- Chrome reported an effective 500px viewport after the narrow resize request.
- The board switched to its compact navigation and retained both ticket rows.
- The ticket detail retained status, labels, blocker controls, and the
  `FACT-2` dependency.
- On both pages, `document.documentElement.scrollWidth` equaled
  `clientWidth` (500px), so no horizontal overflow was present.

The same persistence limitation applied to the narrow screenshot commands.
