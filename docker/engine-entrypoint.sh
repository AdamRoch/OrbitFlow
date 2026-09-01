#!/bin/sh
set -eu

install -d -o node -g node -m 700 \
  /var/lib/orbitflow/runtime \
  /var/lib/orbitflow/runtime/home \
  /var/lib/orbitflow/runtime/state \
  /var/lib/orbitflow/runtime/workspaces
exec su node -s /bin/sh -c 'exec "$@"' -- orbitflow-engine "$@"
