#!/usr/bin/env bash
set -euo pipefail

# Deployment backups can contain the same credentials as the live environment.
# Restrict the known production dotenv locations to the root operator account.
find /root/hivemind -maxdepth 1 -type f -name '.env*' -exec chmod 0600 {} +
if [ -f /root/hivemind-next/infra/.env.next ]; then
  chmod 0600 /root/hivemind-next/infra/.env.next
fi
