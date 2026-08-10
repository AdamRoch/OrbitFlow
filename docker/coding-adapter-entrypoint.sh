#!/bin/sh
set -eu

# `docker compose run coding-adapter <task>` replaces the service command.
# Keep the committed invocation boundary as the entrypoint so that task remains
# an argument to the wrapper instead of becoming a shell command.
exec su node -s /bin/sh -c 'exec node scripts/coding-adapter-invocation.mjs "$@"' orbitflow-coding-adapter-entrypoint "$@"
