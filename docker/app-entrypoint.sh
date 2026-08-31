#!/bin/sh
set -eu

# `su` scans every argument for options unless `--` terminates its own argv.
# Keep the command itself as shell positional parameters so app, engine, and
# profile commands retain their exact executable/argument boundary.
exec su -s /bin/sh -c 'exec "$@"' -- node orbitflow-app-entrypoint "$@"
