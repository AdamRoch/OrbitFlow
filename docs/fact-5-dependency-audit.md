# FACT-5 dependency audit

Audit date: 2026-08-10

The initial `npm audit` reported seven High package entries. `npm audit --omit=dev` reported four of those entries in the production install. This classification follows the installed dependency paths rather than guessing from package names.

| Package entry | Classification | Installed path and disposition |
| --- | --- | --- |
| `next` | Production-applicable | Direct application runtime dependency. Updated from 16.2.10 to 16.3.0. |
| `postcss` | Production-applicable | Shipped through Next and used to process application CSS. Next 16.3.0 supplies patched PostCSS 8.5.23. |
| `sharp` | Production-applicable | Optional Next production dependency for image handling. Next 16.3.0 supplies patched Sharp 0.35.3. |
| `nanoid` | Production-applicable | Transitive dependency of the production PostCSS tree. Lockfile updated to patched Nano ID 3.3.18. |
| `brace-expansion` | Dev-only | Reached through ESLint and TypeScript ESLint tooling. Not present in `npm audit --omit=dev`. |
| `js-yaml` | Dev-only | Reached through ESLint configuration tooling. Not present in `npm audit --omit=dev`. |
| `undici` | Dev-only | Reached through JSDOM/Vitest browser-test tooling. Not present in `npm audit --omit=dev`. |

After the targeted production fixes, `npm audit --omit=dev` reports zero vulnerabilities. Full `npm audit` still reports three High dev-only package entries: `brace-expansion`, `js-yaml`, and `undici`. Those remain visible rather than being folded into an unrelated lint/test-tool dependency upgrade in FACT-5.
