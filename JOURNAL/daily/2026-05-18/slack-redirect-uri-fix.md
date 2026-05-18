# Slack OAuth redirect_uri mismatch

**Date:** 2026-05-18 21:00
**Trigger:** User clicked Authorize in Nango admin → Slack error "redirect_uri did not match any configured URIs"
**Risk:** none (config-only)

## Symptom
```
Passed URI: https://api.hivemind.davinciai.eu:8042/oauth/callback
Slack: redirect_uri did not match any configured URIs
```

## Root cause
Slack OAuth app missing `https://api.hivemind.davinciai.eu:8042/oauth/callback` in **OAuth & Permissions → Redirect URLs** allowlist.

Nango server env confirmed correct:
- `NANGO_SERVER_URL=https://api.hivemind.davinciai.eu:8042`
- `NANGO_PUBLIC_SERVER_URL=https://api.hivemind.davinciai.eu:8042`

## Fix
Slack side only:
1. https://api.slack.com/apps → DAVINCI AI
2. OAuth & Permissions → Redirect URLs → Add New
3. `https://api.hivemind.davinciai.eu:8042/oauth/callback`
4. Save

## Prevention
Updated `JOURNAL/playbooks/nango-providers.md` with mandatory callback URL section at top. Every new provider setup includes this step first.

## Outcome
Pending user action in Slack dashboard, then retry Authorize.
