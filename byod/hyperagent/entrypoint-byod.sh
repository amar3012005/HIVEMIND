#!/bin/sh
set -eu
mkdir -p /var/lib/dsh/hivemind-chat || true
node /opt/byod/ensure-org-fs.mjs || true
exec hivemind-harness-entrypoint "$@"
