# @hivemind/cli

One command to wire HIVEMIND MCP into your AI tools.

```bash
npx @hivemind/cli setup
```

Pick your client from the menu (Claude Code, Claude Desktop, Cursor, VS Code,
Codex, Antigravity), paste your API key, done. The CLI writes the config to
the canonical path your host app already reads, then hits the live endpoint
to confirm tools are reachable before exiting.

## Non-interactive

```bash
HIVEMIND_API_KEY=hmk_live_... npx @hivemind/cli setup claude-code
HIVEMIND_API_KEY=hmk_live_... npx @hivemind/cli setup vscode
HIVEMIND_API_KEY=hmk_live_... npx @hivemind/cli setup codex
```

Works in CI / install scripts. Add `--json` for parseable output.

## What it touches

| Client          | Config path                                                                |
|-----------------|----------------------------------------------------------------------------|
| `claude-code`   | `claude` CLI registry (via `claude mcp add --scope user`)                  |
| `claude-desktop`| `~/Library/Application Support/Claude/claude_desktop_config.json` (per OS) |
| `cursor`        | `~/.cursor/mcp.json`                                                       |
| `vscode`        | User `settings.json` → `mcp.servers.hivemind`                              |
| `codex`         | `~/.codex/config.toml` → `[mcp_servers.hivemind]`                          |
| `antigravity`   | `~/.antigravity/mcp.json`                                                  |

All writes are atomic (tmp + rename) and idempotent — running twice replaces
the existing HIVEMIND entry instead of duplicating it.

## Why npm instead of curl|bash?

- Cross-platform with zero cross-compile (Node ships everywhere)
- Survives Gatekeeper / SmartScreen warnings
- Versioned in the npm registry — users get fixes via `npx`
- Same install pattern every modern AI tool uses

## Local dev

```bash
cd packages/cli
npm install
node ./bin/hivemind.js setup
```

## Custom endpoint

```bash
HIVEMIND_ENDPOINT=https://my-self-hosted.example/api/mcp \
HIVEMIND_API_KEY=hmk_live_... \
  npx @hivemind/cli setup claude-code
```
