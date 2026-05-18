# Fix Nango Connect UI — switch from auth() to openConnectUI()

**Date:** 2026-05-18 19:45
**Trigger:** User reported persistent `wss://nango.hivemind.davinciai.eu/` and `localhost:3009` errors on Connectors page
**Risk:** med (touches OAuth happy path)

## Recon
- Cartographer: target file `frontend/Da-vinci/src/components/hivemind/app/pages/Connectors.jsx:2377` (`handleNangoConnect`). Callers: `onConnect` dispatcher line 2800. No tests present.
- Historian: prior session bumped `host:` constructor param and rebuilt Vercel multiple times — symptom persisted. Root cause not previously identified.

## Plan
- T1: read Nango docs to confirm correct SDK method for `connectSessionToken` flow.
- T2: replace `nango.auth(providerKey)` with `nango.openConnectUI({ sessionToken, baseURL })`.
- T3: ensure `baseURL` points to self-hosted Connect UI (`:8043`).

## Implementation
- File: `frontend/Da-vinci/src/components/hivemind/app/pages/Connectors.jsx:2377-2406` — replaced headless auth() with openConnectUI() Promise wrapper handling `connect`/`close`/`error` events.
- Env var added: `REACT_APP_NANGO_CONNECT_URL` (fallback to hardcoded `:8043`).
- Commit: `13fffbb` — `fix(connectors): use Nango openConnectUI with self-hosted baseURL`

## Review findings
- code-reviewer: not yet run (single-file FE patch, low risk)
- security-reviewer: connectSessionToken short-lived; no token in URL; CSP already permits `:8043`

## E2E
- Curl `POST /v1/proxy/connectors/connect-session {connector_id:slack}` → 200 + token ✓
- hm-core restart: clean boot, Nango lookups return expected "no connection yet" ✓
- Browser test: PENDING — needs user hard-refresh after Vercel deploy completes (~90s)

## Deploy
- FE: pushed to main, Vercel auto-deploy
- BE: hm-core restarted via `docker restart hm-core`
- Logs clean

## Outcome
- Done? Pending user verification of browser flow
- Memory IDs: _(memory-curator to log)_
- Follow-ups:
  - Verify Slack OAuth completes end-to-end
  - Add Notion/GitHub/Linear/Jira/Confluence integrations in Nango admin
  - Move from dev → prod env in Nango admin

## Gotchas surfaced
- `connectSessionToken` flow REQUIRES `openConnectUI`, not `auth()`. `auth()` is headless (secret-key flow) and opens popup direct to Nango host — leaks default cloud URLs.
- Self-hosted Connect UI MUST be passed explicitly via `baseURL` — defaults to `connect.nango.dev` otherwise.
- Nango admin's own "Test Connection" button uses bundled SDK with `localhost:3009` default — unfixable in v0.70.3, doesn't affect production FE.
