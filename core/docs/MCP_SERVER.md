# MCP Server — Canonical Reference

> One endpoint. Three wire formats. Six install scripts.
> This is the source of truth for connecting any MCP-compatible client to HIVEMIND.

---

## 1. The endpoint

**One URL. One bearer token. Every client.**

```
POST https://core.hivemind.davinciai.eu:8050/api/mcp
Authorization: Bearer hmk_live_<your-api-key>
Content-Type: application/json
Accept: application/json, text/event-stream
```

Body = standard MCP JSON-RPC 2.0:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

Auth resolves the caller's user via the API key. All queries are
tenant-scoped — Faraday/Feynman/Turing residents + memory operations
enforce `userId + orgId` on every Prisma query.

---

## 2. Tools exposed

| Category | Tool name | Purpose |
|----------|-----------|---------|
| **Memory core** | `hivemind_recall` | Vector + temporal + tag recall (modes: quick / panorama / insight) |
| | `hivemind_save_memory` | Persist a new memory with tags + metadata |
| | `hivemind_get_memory` | Fetch full content by ID |
| | `hivemind_list_memories` | Filter by tags / type / date range |
| | `hivemind_update_memory` | Update existing memory (auto Updates edge) |
| | `hivemind_delete_memory` | Soft-delete by ID |
| | `hivemind_save_conversation` | Snapshot reasoning trail at end of task |
| | `hivemind_traverse_graph` | Walk outward from a memory by relationship type |
| | `hivemind_query_with_ai` | LLM-synthesized answer over many memories |
| **Web intelligence** | `hivemind_web_search` | Submit async web search job |
| | `hivemind_web_crawl` | Submit async crawl job |
| | `hivemind_web_job_status` | Poll job status |
| | `hivemind_web_usage` | Check daily quota |
| **Coding intelligence** | `hivemind_ingest_code` | Save a code file as a memory w/ version chain |
| | `hivemind_log_decision` | Persist a design / library / API decision |
| | `hivemind_track_refactor` | Log rename / move / split / merge / extract |
| | `hivemind_test_coverage` | Save / list tests covering a function |
| | `hivemind_why_code` | Surface decisions + refactor history for an area |
| | `hivemind_recall_bugs` | Find prior bugs by symptom |
| **Time-travel** | `hivemind_code_at` | "What did this file look like on date X?" |
| | `hivemind_code_diff` | "What changed between time A and B?" |
| | `hivemind_code_timeline` | Every revision of a file with reasons |
| **Personalisation** | `hivemind_set_assistant_name` | User-chosen assistant name |
| | `hivemind_set_voice` | TTS voice preference |
| **Collaboration** | `hivemind_slack_post` | Send Slack message (policy-gated) |
| | `hivemind_slack_react` | Emoji reaction |
| | `hivemind_slack_search` | Search Slack workspace |
| | `hivemind_slack_history` | Channel history |

`tools/list` returns the live catalog with full JSON schemas.

---

## 3. Wire formats — pick by client

ONE backend. THREE wire formats wrapping the same JSON-RPC.

### Format A — HTTP direct (preferred, modern clients)
Client speaks JSON-RPC over plain HTTP to `/api/mcp`.

```json
{
  "mcpServers": {
    "hivemind": {
      "type": "http",
      "url": "https://core.hivemind.davinciai.eu:8050/api/mcp",
      "headers": {
        "Authorization": "Bearer hmk_live_<key>"
      }
    }
  }
}
```

Cursor and Antigravity use `transport: "http"` instead of `type: "http"` — same shape otherwise.

VS Code nests under `mcp.servers`:
```json
{
  "mcp": {
    "servers": {
      "hivemind": {
        "type": "http",
        "url": "https://core.hivemind.davinciai.eu:8050/api/mcp",
        "headers": { "Authorization": "Bearer hmk_live_<key>" }
      }
    }
  }
}
```

**Use when:** client supports HTTP MCP transport (Claude Code,
Claude Desktop 0.7+, Cursor, Antigravity, VS Code, Windsurf,
any modern MCP host).

### Format B — stdio bridge via `mcp-remote` (universal fallback)
Client spawns `npx -y mcp-remote <URL>` which proxies stdio → HTTP.

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://core.hivemind.davinciai.eu:8050/api/mcp",
        "--header",
        "Authorization: Bearer hmk_live_<key>"
      ]
    }
  }
}
```

Windows variant — cmd.exe doesn't quote `C:\Program Files\nodejs\npx.cmd`
properly, so wrap with `cmd /c`:

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "mcp-remote",
        "https://core.hivemind.davinciai.eu:8050/api/mcp",
        "--header",
        "Authorization: Bearer hmk_live_<key>"
      ]
    }
  }
}
```

**Use when:** client only speaks stdio MCP (Claude Desktop ≤ 0.6,
NotebookLM, Cline, legacy Cursor). Also fine as fallback if HTTP
direct misbehaves.

### Format C — Legacy: `@amar_528/mcp-bridge` (DEPRECATED)
First-generation stdio bridge with two modes (pinned-server URL OR
base URL + env-var key). Kept on the server for installed users; new
installs should NOT pick this.

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "npx",
      "args": [
        "-y",
        "@amar_528/mcp-bridge",
        "hosted",
        "--url",
        "https://core.hivemind.davinciai.eu:8050/api/mcp/servers/<userId>"
      ]
    }
  }
}
```

Or with env key:
```json
{
  "mcpServers": {
    "hivemind": {
      "command": "npx",
      "args": [
        "-y",
        "@amar_528/mcp-bridge",
        "hosted",
        "--url",
        "https://core.hivemind.davinciai.eu:8050/api/mcp"
      ],
      "env": {
        "HIVEMIND_API_KEY": "hmk_live_<key>"
      }
    }
  }
}
```

**Why deprecated:**

| Reason | Detail |
|--------|--------|
| Descriptor pre-fetch | Hits `GET /api/mcp/servers/<userId>` for tool list before any RPC — extra round trip + 404 if the user-ID path isn't pinned |
| Two auth modes (URL or env) | Confusing — users mix them up, get cryptic errors |
| Connection token system | Required pre-generated tokens from FE; another moving piece |
| No HTTP fallback | Pure stdio — modern clients have to pay the JSON-RPC marshalling cost |
| `--bearer` flag silently ignored | Common copy-paste failure mode |

**Migration path** (existing users):
1. Open `/hivemind/app/connectors` → click Claude Code → grab the new schema
2. Replace the `@amar_528/mcp-bridge` block in the relevant config file (`~/.claude.json`, `claude_desktop_config.json`, etc.) with the Format A (HTTP) or Format B (mcp-remote) block above
3. Restart the client

**Server-side** the legacy descriptor endpoint `/api/mcp/servers/:userId`
and RPC endpoint `/api/mcp/servers/:userId/rpc` stay live to keep existing
installs working. Plan to deprecate after 90 days of zero traffic.

---

## 4. Per-client setup matrix

| Client | Config path | Preferred format | Schema key |
|--------|-------------|------------------|------------|
| **Claude Code** | `~/.claude.json` | B (mcp-remote stdio) | `mcpServers.hivemind.{command, args}` |
| **Claude Desktop ≥ 0.7** macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` | B (mcp-remote stdio) | same |
| **Claude Desktop ≥ 0.7** Linux | `~/.config/Claude/claude_desktop_config.json` | B (mcp-remote stdio) | same |
| **Claude Desktop ≥ 0.7** Windows | `%APPDATA%\Claude\claude_desktop_config.json` | B (cmd-wrapped stdio) | `command: cmd, args: [/c, npx, …]` |
| **Claude Desktop ≤ 0.6** | same path as 0.7 | B (mcp-remote stdio, mandatory — no HTTP support) | same |
| **Cursor** | `~/.cursor/mcp.json` | A (HTTP direct) | `mcpServers.hivemind.{transport: "http", url, headers}` |
| **Antigravity** | `~/.antigravity/mcp.json` | A (HTTP direct) | same as Cursor |
| **VS Code** | `~/Library/Application Support/Code/User/settings.json` (mac) | A (HTTP direct) | `mcp.servers.hivemind.{type: "http", url, headers}` |
| **VS Code** Linux | `~/.config/Code/User/settings.json` | A | same |
| **VS Code** Windows | `%APPDATA%\Code\User\settings.json` | A | same |
| **NotebookLM** | `~/.hivemind/notebooklm-bridge.sh` (script that wraps stdio) | B (mcp-remote stdio via local script) | bash script that execs `npx -y mcp-remote …` |
| **Cline / Windsurf / other** | client-specific | A first, B fallback | use mcp-remote stdio block if HTTP unsupported |

---

## 5. Install scripts (one-liner per client)

All hosted under `https://hivemind.davinciai.eu/install/`.

```bash
# Claude Code (writes both ~/.claude.json AND Claude Desktop config)
curl -fsSL https://hivemind.davinciai.eu/install/claude-code.sh \
  | HIVEMIND_KEY="hmk_live_..." bash

# Claude Desktop only
curl -fsSL https://hivemind.davinciai.eu/install/claude-desktop.sh \
  | HIVEMIND_KEY="hmk_live_..." bash

# Cursor
curl -fsSL https://hivemind.davinciai.eu/install/cursor.sh \
  | HIVEMIND_KEY="hmk_live_..." bash

# Antigravity
curl -fsSL https://hivemind.davinciai.eu/install/antigravity.sh \
  | HIVEMIND_KEY="hmk_live_..." bash

# VS Code
curl -fsSL https://hivemind.davinciai.eu/install/vscode.sh \
  | HIVEMIND_KEY="hmk_live_..." bash

# NotebookLM (writes local bridge script)
curl -fsSL https://hivemind.davinciai.eu/install/notebooklm.sh \
  | HIVEMIND_KEY="hmk_live_..." bash

# Uninstall any of the above
curl -fsSL https://hivemind.davinciai.eu/install/uninstall.sh \
  | bash -s <client-name>
```

What each script does, in order:
1. Detect OS (macOS / Linux / WSL / Windows-Git-Bash / Windows)
2. **Quit the target app** (osascript / pkill) — Electron apps overwrite
   config on quit, so we must edit while they're closed
3. Locate the config file (per-OS path)
4. Back up to `<file>.bak.<timestamp>`
5. Merge `mcpServers.hivemind` into the JSON (preserves other entries)
6. Verify by hitting `POST /api/mcp` with `tools/list` and counting tools
7. Prompt to relaunch the app
8. Write an audit row to `~/.hivemind/installed.json`

Env vars accepted:
- `HIVEMIND_KEY` — bearer key (required unless interactive)
- `HIVEMIND_MCP_URL` — override endpoint (testing)
- `ASSUME_YES=1` — non-interactive (auto-confirm prompts)
- `NON_INTERACTIVE=1` — skip key prompt if `HIVEMIND_KEY` set
- `USE_BRIDGE=1` (claude-desktop.sh only) — force legacy stdio bridge if HTTP fails on the target Desktop version
- `OS=<macos|linux|wsl|windows>` — override OS detection for CI

---

## 6. Endpoint catalog

| Method | Path | Use |
|--------|------|-----|
| `POST` | `/api/mcp` | **Canonical MCP JSON-RPC endpoint.** All new installs hit this. |
| `POST` | `/api/mcp/rpc` | Alias for `/api/mcp` (some clients expect `/rpc` suffix) |
| `POST` | `/api/mcp/message` | Alias for `/api/mcp` (older spec naming) |
| `GET` | `/api/mcp/servers/:userId?token=<x>` | **Legacy:** fetch server descriptor (tools list) for `@amar_528/mcp-bridge` |
| `POST` | `/api/mcp/servers/:userId/rpc?token=<x>` | **Legacy:** JSON-RPC for `@amar_528/mcp-bridge` |
| `POST` | `/api/mcp/servers/:userId/message?token=<x>` | **Legacy:** alias |
| `POST` | `/api/mcp/consumer-url` | Create a personalized consumer URL (FE Connectors page) |

The `/api/mcp/servers/...` family stays alive for existing installs. New
installs never see it. The HIVEMIND-FE `/mcp` page now shows only the
HTTP and `mcp-remote` schemas.

---

## 7. Verification flow

After install, three checks confirm the connection works:

### Check 1: Endpoint reachability
```bash
curl -fsS https://core.hivemind.davinciai.eu:8050/api/mcp \
  -X POST \
  -H "Authorization: Bearer hmk_live_..." \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
Expect: HTTP 200 with `"tools": [ ... ]` array (~30 entries).

### Check 2: Tool execution
```bash
curl -fsS https://core.hivemind.davinciai.eu:8050/api/mcp \
  -X POST \
  -H "Authorization: Bearer hmk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"hivemind_recall","arguments":{"query":"test","mode":"quick","limit":1}}}'
```
Expect: HTTP 200 with `result.content[].text` containing memories (or empty).

### Check 3: Client-side (Claude Code CLI)
```bash
claude mcp list
```
Expect line: `hivemind: <URL> - ✓ Connected` (HTTP) or `hivemind: npx … mcp-remote … - ✓ Connected` (stdio).

The install scripts perform Check 1 and report tool count in their output.

---

## 8. Auth + API keys

API keys are scoped + revocable:

| Scope | Allows |
|-------|--------|
| `memory:read` | `hivemind_recall`, `hivemind_get_memory`, `hivemind_list_memories`, `hivemind_traverse_graph` |
| `memory:write` | All memory mutations |
| `mcp` | Required to hit `/api/mcp` at all |
| `coding` | `hivemind_ingest_code`, `hivemind_log_decision`, etc. |
| `web_search` | Web search tools |
| `web_crawl` | Web crawl tools |
| `*` | Admin — all scopes |

Keys created via `/hivemind/app/keys` page in the FE or
`POST /api/keys/create` endpoint. Stored hashed (SHA-256 + bcrypt for legacy).
Key prefix `hmk_live_` for production, `hmk_test_` for sandbox.

Rate limiting: per-key `rate_limit_per_minute` (default 120).

---

## 9. Operational FAQ

### Q: Stale FE chunk shows old `claude mcp add` CLI snippet — why?
Browser cached the React bundle. Hard-refresh (Cmd+Shift+R). Vercel
deploy hash is in the JS filename — verify the chunk hash matches the
latest deploy in the Network tab.

### Q: Connection works in HTTP curl test but client says "schema invalid"
Claude Desktop ≤ 0.6 doesn't support HTTP transport at all. Use Format B
(mcp-remote stdio). Newer Cursor / VS Code: check the field name
(`type` vs `transport`) — they reject the wrong one.

### Q: `mcp-remote` fails on Windows with "Der Befehl C:\Program ist falsch"
cmd.exe wrapping `C:\Program Files\nodejs\npx.cmd` splits on the space.
Use the cmd-wrapped variant (Format B Windows shape). Or install
mcp-remote globally:
```powershell
npm install -g mcp-remote
```
Then use `"command": "mcp-remote"` directly.

### Q: `Hosted mode requires HIVEMIND_API_KEY when --url is a base API URL`
That's `@amar_528/mcp-bridge` complaining. Either:
- Add `env: { HIVEMIND_API_KEY: "hmk_live_..." }` to the JSON, OR
- Switch to Format B (`mcp-remote`) — much simpler

### Q: `Descriptor fetch failed (404 Not Found)`
That's `@amar_528/mcp-bridge` trying to fetch a pinned-server descriptor
from `/api/mcp/servers/<userId>?token=<x>` and finding nothing. Either:
- Use a pinned-server URL (with userId path), not the base `/api/mcp`, OR
- Switch to Format B (`mcp-remote`)

### Q: Claude Desktop sees mcpServers: {} after install
Race condition. Claude Desktop holds the config in memory + rewrites it
on quit, overwriting our edit. Install script fixes this by quitting the
app FIRST. If running manually, quit Claude Desktop fully (Cmd+Q from
menu bar, not just window-close) before editing the config.

### Q: My API key worked yesterday, doesn't today
Possible causes:
- Key revoked at `/hivemind/app/keys`
- Rate limit hit (default 120/min)
- Token expired (long-lived keys never expire; check if you generated a session token instead)

Test with curl:
```bash
curl -fsS https://core.hivemind.davinciai.eu:8050/api/health \
  -H "Authorization: Bearer hmk_live_..."
```
Expect: `{"status":"ok"}`. Auth failure returns 401 + error detail.

### Q: How to use multiple HIVEMIND accounts in one client
Each entry in `mcpServers` is independent. Name them differently:
```json
{
  "mcpServers": {
    "hivemind-personal": { ... bearer for personal key ... },
    "hivemind-work":     { ... bearer for work key ... }
  }
}
```
The MCP host (Claude/Cursor/etc.) shows each as a separate server with
its own tool namespace.

---

## 10. Lock-in summary

| Decision | Status |
|----------|--------|
| One canonical endpoint URL | ✅ `https://core.hivemind.davinciai.eu:8050/api/mcp` |
| One bearer auth scheme | ✅ `Authorization: Bearer hmk_live_<key>` |
| Two supported wire formats going forward | ✅ HTTP direct + `mcp-remote` stdio |
| One install script per client | ✅ 6 scripts at `/install/<client>.sh` |
| Universal uninstaller | ✅ `/install/uninstall.sh` |
| `@amar_528/mcp-bridge` for new installs | ❌ deprecated, kept server-side for legacy users |
| Claude Code / Desktop default | ✅ `mcp-remote` stdio (max compatibility) |
| Cursor / Antigravity / VS Code default | ✅ HTTP direct |
| Windows-aware install scripts | ✅ `cmd /c npx` wrapper |
| Quit-before-write race protection | ✅ shipped |
| FE `/mcp` page shows JSON schema (not CLI) | ✅ shipped |
| Per-tenant API keys w/ scope gating | ✅ shipped |

This is the final state. Anything that drifts from this is a bug.

---

## 11. File index

```
core/src/
├── server.js                                # /api/mcp endpoints (POST, /rpc, /message)
└── mcp/
    └── hosted-service.js                    # Tool catalog, hosted-server descriptor, connection tokens

frontend/Da-vinci/
├── public/install/
│   ├── installer-common.sh                  # Shared lib (OS detect, jq merge, quit_app_before_write, verify_mcp_loaded)
│   ├── claude-code.sh                       # Claude Code + Claude Desktop combined
│   ├── claude-desktop.sh                    # Claude Desktop only
│   ├── cursor.sh                            # Cursor
│   ├── antigravity.sh                       # Antigravity
│   ├── vscode.sh                            # VS Code (JSONC-aware)
│   ├── notebooklm.sh                        # Local bridge script
│   ├── remote-mcp.sh                        # Manual config printer for any client
│   └── uninstall.sh                         # Universal cleanup
└── src/components/hivemind/app/pages/
    ├── McpServer.jsx                        # /mcp Quick Setup page (Claude/Cursor/VS Code/REST cards)
    └── Connectors.jsx                       # /connectors page w/ McpSetupModal per client
```

---

## 12. Env switches reference

| Var | Default | Effect |
|-----|---------|--------|
| `HIVEMIND_API_KEY_REQUIRED` | `true` | Off → anonymous access (dev only) |
| `MASTER_API_KEY` | — | Bypass key for internal services |
| `MCP_TOOL_BUDGET` | unlimited | Cap per-key tool calls per minute |
| `HIVEMIND_FRONTEND_URL` | `https://hivemind.davinciai.eu` | Used for OAuth redirects |
| `HIVEMIND_BASE_URL` | derived | Used for self-referential URL composition |

For install scripts, see Section 5.

---

## 13. Migration checklist (for users on legacy `@amar_528/mcp-bridge`)

If `claude mcp list` shows a `@amar_528/mcp-bridge` entry:

1. Run the new install script for your client:
   ```bash
   curl -fsSL https://hivemind.davinciai.eu/install/claude-code.sh \
     | HIVEMIND_KEY="hmk_live_..." bash
   ```
2. Verify the entry replaced cleanly:
   ```bash
   claude mcp list
   ```
   Should now show: `hivemind: <URL> (HTTP) - ✓ Connected`
   OR: `hivemind: npx -y mcp-remote <URL> ...`
   NOT: `hivemind: npx -y @amar_528/mcp-bridge ...`
3. Restart the client.
4. Test with: ask the assistant "Can you list my recent memories?" — if
   tools resolve, you're on the new path.

If anything misbehaves: rollback by editing the config file back to the
legacy block — it still works server-side.

---

## 14. Acknowledgements

This document supersedes any earlier README snippets. If you see
documentation, scripts, or FE config blocks that contradict this file,
they're stale. Open an issue or fix in place.

Last lock-in: 2026-05-17.
