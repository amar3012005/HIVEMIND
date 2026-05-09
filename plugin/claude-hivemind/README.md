# claude-hivemind

A Claude Code plugin that gives your AI **persistent memory + bi-temporal time travel** across sessions, machines, and projects — backed by [HIVEMIND](https://hivemind.davinciai.eu).

22 MCP tools across four streams:

- **Memory (9):** `save_memory`, `recall`, `get_memory`, `list_memories`, `update_memory`, `delete_memory`, `save_conversation`, `traverse_graph`, `query_with_ai`
- **Web Intelligence (4):** `web_search`, `web_crawl`, `web_job_status`, `web_usage`
- **Coding Intelligence (6):** `ingest_code`, `recall_bugs`, `log_decision`, `track_refactor`, `test_coverage`, `why_code`
- **Time Travel (3):** `code_at`, `code_diff`, `code_timeline`

## Install

```bash
/plugin marketplace add amar3012005/claude-hivemind
/plugin install claude-hivemind
/hivemind:connect
```

`/hivemind:connect` opens your browser for OAuth (Zitadel SSO or Google), then writes credentials to `~/.hivemind-claude/credentials.json`. The MCP server picks them up on the next session.

## Commands

| Command | Description |
|---------|-------------|
| `/hivemind:connect` | Sign in via browser OAuth |
| `/hivemind:logout` | Remove cached credentials |
| `/hivemind:index-codebase` | Bulk-ingest the current repo so future sessions inherit context |

## Hooks

`SessionStart` runs `scripts/ensure-auth.cjs` to load credentials into env vars (`HIVEMIND_API_KEY`, `HIVEMIND_USER_ID`) for the MCP bridge.

## Skill: memory-discipline

The plugin ships a skill (`memory-discipline`) that documents the recall→ingest→log→track loop. Claude Code activates it on every session so the model knows to use HIVEMIND aggressively.

## Architecture

- **Control plane:** `https://api.hivemind.davinciai.eu:8040` — auth, OAuth callbacks, API key issuance, multi-tenant proxy.
- **Core API:** `https://core.hivemind.davinciai.eu:8050` — memory ingest, recall, graph traversal, MCP bridge.
- **MCP bridge:** `npx -y @amar_528/mcp-bridge hosted --url <core>/api/mcp/servers/<user_id>` — relays Claude Code MCP calls to your tenant-scoped HIVEMIND endpoint.

## Configuration

Override defaults via env vars:

| Env | Default | Purpose |
|-----|---------|---------|
| `HIVEMIND_CONTROL_PLANE` | `https://api.hivemind.davinciai.eu:8040` | Auth + bootstrap |
| `HIVEMIND_CORE_API` | `https://core.hivemind.davinciai.eu:8050` | MCP + REST API |
| `HIVEMIND_AUTH_PORT` | `19876` | Local OAuth callback port |
| `HIVEMIND_AUTH_TIMEOUT_MS` | `120000` | Browser OAuth timeout |

## Privacy

Credentials live only in `~/.hivemind-claude/credentials.json` (mode 600, your home dir). Never committed, never sent off-machine. The plugin contains no telemetry. Server-side data lives in EU (Frankfurt), GDPR-compliant.

## License

MIT
