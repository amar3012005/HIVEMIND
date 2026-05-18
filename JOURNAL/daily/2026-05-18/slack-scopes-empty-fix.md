# Slack OAuth — empty scopes + wrong template

**Date:** 2026-05-18 21:15
**Trigger:** Slack error "Invalid permissions requested. No scopes requested" after redirect URI added
**Risk:** none (config-only)

## Symptom
Slack URL: `scope=&user_scope=` empty → "No scopes requested"

## Recon
- nango-specialist dispatched
- Curl `GET /config/slack` returned:
  ```json
  {"config":{"unique_key":"slack","provider":"slack-mcp","syncs":[],"actions":[]}}
  ```

## Root causes (TWO)
1. Provider template = `slack-mcp` (wrong). HIVEMIND catalog expects standard `slack` (OAuth2 bot flow). slack-mcp uses different auth path.
2. No `oauth_scopes` configured on the integration.

## Fix
Admin UI:
1. Delete `slack` integration
2. Recreate with provider = **`slack`** (NOT slack-mcp)
3. Scopes (comma-separated):
   ```
   channels:history,channels:read,chat:write,users:read,groups:history,im:history,mpim:history,team:read
   ```

## Prevention
`JOURNAL/playbooks/nango-providers.md` updated with "Provider template selection (CRITICAL)" section warning against MCP-suffixed templates.

## Outcome
Pending user redo in admin UI.
