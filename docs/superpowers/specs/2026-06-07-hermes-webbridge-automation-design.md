# Web-bridge automation — drive the user's real browser from a server-side Hermes agent

**Date:** 2026-06-07 · **Status:** approved (relay + browser-MCP), executing
**Builds on:** Hermes v2 (per-tenant single agent, mgmt transport, profile config). Live.

## Goal
Give each tenant's Hermes agent a **default web-automation tool** that drives the
**user's own logged-in browser** — research, form-fill, navigation, extraction —
white-labelled as "Web-bridge automation". Engine = Kimi WebBridge (local daemon +
Chrome extension). Also permanently fixes the `tool call … not in request.tools`
class by putting real browser tools in `request.tools`.

## Hard fact (the whole design hangs on this)
Kimi WebBridge is a **localhost daemon** (`http://127.0.0.1:10086`) + Chrome extension
on the **user's machine**. Our Hermes agent runs **server-side** (Hetzner) and cannot
reach a user's localhost. So we bridge with: **agent → browser-MCP (server) → relay
(server, wss) → connector (user machine, dials OUT) → Kimi daemon (localhost:10086) →
user's Chrome.** We do NOT repackage Kimi's binaries — we ship a thin **connector**
that talks to their local HTTP API.

## Components
1. **Relay** (server, in/near hm-control; public via caddy, wss). Two roles:
   - `/webbridge/connector` (wss): a tenant's connector registers with a per-tenant
     **pairing token**; relay tracks tenant → live connector socket.
   - agent side: the browser-MCP submits `{tenantId, action, args}`; relay routes to
     that tenant's connector, awaits the daemon's reply, returns it. Per-tenant only.
2. **Connector** (user machine): thin script/daemon (OUR code). Dials OUT (wss) to the
   relay with the pairing token, receives commands, POSTs them to `127.0.0.1:10086/command`,
   streams results back. Whitelabelled install: `curl …/webbridge/connect.sh | bash <token>`.
   Assumes/Checks the Kimi daemon is installed (`~/.kimi-webbridge/bin/kimi-webbridge status`).
3. **Browser-tools MCP** (server, co-located with hm-hermes). Exposes the WebBridge API as
   MCP tools: `navigate, find_tab, snapshot, click, fill, evaluate, screenshot, network,
   upload, save_as_pdf, list_tabs, close_session`. Each call → relay RPC for the tenant.
   Wired into the profile `config.yaml` mcp block (alongside hivemind) via the mgmt server +
   restart → tools land in `request.tools`.
4. **Control-plane routes** (control-routes.js): `GET /hermes/agent/browser` (paired? status),
   `POST /hermes/agent/browser/pair` (mint pairing token + return whitelabelled connect
   command), `DELETE /hermes/agent/browser` (unpair/rotate). Pairing persisted (new
   `hermes_browser_pairings` table or in agent config; token hashed).
5. **FE**: a "Web Automation" card (Home or Channels-style) — "Connect your browser" → show
   the connect command + token + **live pairing status**; once paired, the agent can browse.

## Security
- Per-tenant **pairing token** (hashed at rest, rotatable, revocable). Relay authenticates
  every connector by token → tenant; commands are routed ONLY to that tenant's connector.
- A server agent driving a user's logged-in browser is powerful → per-task consent + clear
  status; unpair kills it instantly.
- `isTrusted`-strict sites (banking/captcha) reject synthetic click/fill — documented limit.
- Connector runs on the user's machine, outbound-only (no inbound ports opened).

## Dependency caveat (accepted)
Kimi daemon + extension are third-party (`cdn.kimi.com`); their pairing protocol is "not
finalized". We depend on their local HTTP API staying stable. Mitigation: the browser-MCP
tool interface is backend-swappable (a server-headless backend can replace WebBridge later
without changing the agent-facing tools).

## Phasing (sequential; verified per phase)
- **P1 — Relay + connector + pairing.** wss relay in hm-control; pairing token mint/store;
  connector script; `GET/POST/DELETE /hermes/agent/browser`. PROVE the roundtrip: server →
  relay → connector → `localhost:10086` `navigate`+`snapshot` → result back. (Needs the user
  to install Kimi daemon + run the connector once to verify.)
- **P2 — Browser-tools MCP wired into Hermes.** MCP server exposing the WebBridge actions,
  wired into the profile config.yaml mcp block; agent drives the browser end-to-end (Tasks
  run "go to X and extract Y"). Re-introduce browser capabilities in library templates.
- **P3 — FE onboarding + default.** "Connect your browser" card (command + token + status);
  make web automation the default tool surfaced in Tasks/Library; update templates to use it.

## Constraints
- NEVER edit core/src/server.js (use control-plane-server.js). Author amarsai3012005.
- Two control-planes share /opt/HIVEMIND/core bind mount; PUBLIC = control-plane-s0k0 (Coolify,
  caddy-api:8040). wss must pass through caddy (ws upgrade). Flag-gate everything default-OFF.
- FE = Da-vinci main (Vercel). Verify HEAD==main before FE commits (branch-thrash gotcha).
- Verify each phase; deploy default-safe before next.
