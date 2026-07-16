#!/usr/bin/env bash
# One-time: put the CENTRAL engine host on the tailnet so it can reach BYOD customers' Postgres+Qdrant.
# Run on the central server (where hm-core runs). Idempotent.
#   sudo ./infra/tailscale-central.sh <tailscale-auth-key>
set -euo pipefail
KEY="${1:-${TS_AUTHKEY:-}}"
[ -n "$KEY" ] || { echo "usage: sudo ./tailscale-central.sh <tailscale-auth-key>  (or set TS_AUTHKEY)"; exit 1; }

# 1. install tailscale if missing
if ! command -v tailscale >/dev/null 2>&1; then
  echo "[ts] installing tailscale…"
  curl -fsSL https://tailscale.com/install.sh | sh
fi

# 2. join the tailnet, tagged as central (so the ACL can target it)
echo "[ts] joining tailnet as tag:hivemind-central…"
tailscale up --authkey="$KEY" --advertise-tags=tag:hivemind-central --accept-routes

echo "[ts] central node:"
tailscale status | head -3

cat <<'ACL'

────────────────────────────────────────────────────────────────────
Add this to your Tailscale ACL (admin console → Access Controls) so central
can reach each BYOD customer's Postgres(5432) + Qdrant(6333), nothing else:

  "tagOwners": { "tag:hivemind-central": ["autogroup:admin"], "tag:hivemind-byod": ["autogroup:admin"] },
  "acls": [
    { "action": "accept",
      "src": ["tag:hivemind-central"],
      "dst": ["tag:hivemind-byod:5432", "tag:hivemind-byod:6333"] }
  ]

Then a customer registers pgUrl/qdrantUrl using their tailnet hostname
(hivemind-byod.<tailnet>.ts.net), and core reaches it over WireGuard. Done.
────────────────────────────────────────────────────────────────────
ACL
