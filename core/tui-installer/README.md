# HIVEMIND MCP — TUI Installer

Visually stunning terminal installer (Grok aesthetic) for wiring HIVEMIND
into Claude Code, Claude Desktop, Codex, Antigravity, and VS Code in one
keystroke.

Built with the **Charm** stack:

| Library | Role |
|---------|------|
| `bubbletea`  | Event loop + state machine |
| `bubbles`    | Spinner + text input components |
| `lipgloss`   | Colour palette, borders, alignment |

## Run from source

```bash
cd core/tui-installer
make deps
make run
```

## Cross-compile binaries

```bash
make release ENDPOINT=https://core.hivemind.davinciai.eu:8050/api/mcp VERSION=0.1.0
ls dist/
# hivemind-mcp-darwin-arm64
# hivemind-mcp-darwin-amd64
# hivemind-mcp-linux-amd64
# hivemind-mcp-linux-arm64
# hivemind-mcp-windows-amd64.exe
```

Drop the binaries into the control plane's static asset bucket so the
Connectors page can hand each user a one-line download:

```bash
# macOS / Linux
curl -fsSL https://core.hivemind.davinciai.eu:8050/install/tui | bash

# Windows PowerShell
irm https://core.hivemind.davinciai.eu:8050/install/tui.ps1 | iex
```

## Supported clients

| ID              | Config destination                                |
|-----------------|---------------------------------------------------|
| `claude-code`   | `claude mcp add` (CLI)                            |
| `claude-desktop`| `~/Library/Application Support/Claude/claude_desktop_config.json` (per OS) |
| `codex`         | `~/.codex/config.toml` → `[mcp_servers.hivemind]` |
| `antigravity`   | `~/.antigravity/mcp.json`                         |
| `vscode`        | `User/settings.json` → `mcp.servers.hivemind`     |

Each install routine is **idempotent** — running twice replaces the
existing HIVEMIND entry instead of duplicating it.

## Flags / env

| Flag           | Env                 | Default                                                        |
|----------------|---------------------|----------------------------------------------------------------|
| `--endpoint`   | —                   | (baked at build via `-ldflags -X main.defaultEndpoint=...`)    |
| `--api-key`    | `HIVEMIND_API_KEY`  | empty → prompted in-TUI                                        |
