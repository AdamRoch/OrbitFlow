# Live model suggestions

Status: Accepted implementation decision under Adam's delegated design authority, 2026-09-17.

The agent editor uses a searchable model dropdown backed by OpenRouter's public Models API. The server requests weekly popularity ordering and tool support, then checks text input/output support and excludes expired entries, moving routers, and batch variants. Suggestions show model names, exact IDs, context windows, and input/output token prices. Users can also sort by output price or enter an explicit model ID for any already supported provider.

Popularity measures token usage, not coding quality or success in OrbitFlow. These are discovery suggestions, not tested recommendations. We do not infer model quality from popularity, create an automatic router, or change an existing agent when the catalog changes. New agents require an explicit selection. Runtime configuration and immutable run snapshots still retain the selected ID.

Metadata requests go through the existing authenticated studio API and send no provider credentials to OpenRouter. Cache the catalog in the application process for 30 minutes, coalesce concurrent fetches, and allow manual refresh. If refresh fails, identify the retained catalog as stale with its original timestamp. If no catalog is available, keep manual entry usable. Displayed prices are catalog estimates; provider routing, context pricing, discounts, and actual token usage determine the bill.

Source: [OpenRouter Models API](https://openrouter.ai/docs/guides/overview/models). Live metadata requests verified weekly ordering and tool filtering; model execution remains a separate check.

## Listing dates and coding scores, September 17

Show OpenRouter's `created` timestamp as an **Added** month, with the full UTC date on hover. It records when the model joined OpenRouter, not necessarily the developer's release date. Do not infer a release date from the model name or knowledge cutoff. Dates remain visible after selection, and users can sort newest listings first.

Show `benchmarks.artificial_analysis.coding_index` from the same model record as **Coding index**, with Artificial Analysis attribution and links to methodology and the selected model's benchmark details. The public catalog already supplies this field; no second API, credentials, scraped leaderboard, or manually maintained model mapping is needed. Do not substitute the general intelligence index or combine unrelated benchmark scales. Evaluation settings can differ from the agent's runtime settings, so this is comparison metadata rather than a guarantee of OrbitFlow performance. The catalog fetch timestamp is not a benchmark-run date.

Missing or malformed optional dates/scores remain unknown without dropping an otherwise usable model. Zero is a valid score. Highest-coding-index sorting places unknown scores last, and no score is inherited from another family member. These fields never enter saved agent configurations or runtime snapshots; selection still saves only the exact model ID.

Benchmark interpretation: [Artificial Analysis methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking). Public catalog metadata and edge-case fixtures are checked locally; no model inference is required.
