# GitHub as the deployment source

Status: Accepted by Adam, 2026-09-17. Minimal CI; testing stays local.

Publish the rebuild to `AdamRoch/OrbitFlow` on `orbitflow-v2` and merge it into the existing `main`. Preserve the previous main at the `orbitflow-v1-before-v2` tag. Import the rebuild as a replacement application tree based on the existing GitHub history so the change has a normal pull request. Keep the separate local rebuild history on `codex/local-v2-history`.

The existing OrbitFlow-v2 production studio service will follow GitHub `main`. Its PostgreSQL service, provider budget, runtime checkpoint, credentials, Telegram configuration, and domains stay attached to the same Railway resources. The original OrbitFlow deployment remains separate.

GitHub Actions has one job that installs locked dependencies, typechecks, and builds. It runs on pull requests and pushes to main. Tests, browser checks, and model-backed acceptance stay local or explicitly authorized; CI has no provider credentials or model calls. Railway's Wait for CI setting gates automatic deployments on that workflow. CI verifies compilation, not product acceptance.

Normal delivery is a branch, local verification, pull request, merge, and automatic deployment. A successful merge, successful CI run, successful Railway deployment, and verified live behavior are separate facts. Check the deployed GitHub commit and `/healthz`, then inspect the affected UI. Direct CLI uploads are reserved for explicit recovery work.
