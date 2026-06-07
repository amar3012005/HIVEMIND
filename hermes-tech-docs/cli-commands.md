# Hermes Agent — CLI Command Reference

**Sources:** https://hermes-agent.nousresearch.com/docs/reference/cli-commands · https://hermes-agent.nousresearch.com/docs/user-guide/cli

Distilled, build-critical reference for running, deploying, and testing Hermes agents programmatically. Both source pages live (no 404s).

---

## Global Entrypoint & Options

```
hermes [global-options] <command> [subcommand/options]
```

| Flag | Short | Effect |
|------|-------|--------|
| `--version` | `-V` | Show version |
| `--profile <name>` | `-p` | Select profile |
| `--resume <session>` | `-r` | Resume by ID/title |
| `--continue [name]` | `-c` | Resume most recent (optionally by name lineage) |
| `--worktree` | `-w` | Run in isolated git worktree |
| `--yolo` | | Bypass approval prompts |
| `--pass-session-id` | | Include session ID in system prompt |
| `--ignore-user-config` | | Skip `~/.hermes/config.yaml` |
| `--ignore-rules` | | Skip auto-injection of rules/memory |
| `--tui` | | Launch TUI |
| `--cli` | | Force classic REPL |
| `--dev` | | Run TypeScript sources (TUI contributors) |

**Scripted one-shot (most important for programmatic use):**
```bash
hermes -z "prompt"          # Pure final output, no banner/metadata/spinners
hermes -w -z "Fix issue #123"   # one-shot inside isolated git worktree
```

---

## `hermes chat` — run the agent

```
hermes chat [options]
```
| Flag | Short | Default | Meaning |
|------|-------|---------|---------|
| `--query "..."` | `-q` | | One-shot prompt (non-interactive) |
| `--model <model>` | `-m` | | Override model, e.g. `anthropic/claude-sonnet-4` |
| `--toolsets <csv>` | `-t` | | Comma list, e.g. `web,terminal,skills` |
| `--provider <name>` | | | Force provider: `nous`, `anthropic`, `openai`, `openrouter`, `xai`, ... |
| `--skills <name>` | `-s` | | Preload skill (repeatable, or CSV) |
| `--verbose` | `-v` | | Debug output |
| `--quiet` | `-Q` | | Suppress banner/spinners (use for scripting) |
| `--image <path>` | | | Attach image |
| `--checkpoints` | | | Enable filesystem checkpoints |
| `--max-turns <N>` | | `90` | Max tool iterations |

```bash
hermes chat -q "Hello" -m "anthropic/claude-sonnet-4" --provider nous
hermes chat --toolsets "web,terminal,skills"
hermes chat -s github-pr-workflow -q "open a draft PR"
hermes -s hermes-agent-dev,github-auth        # preload skills at launch
```

---

## `hermes gateway` — messaging / service daemon

```
hermes gateway <run|start|stop|restart|status|list|install|uninstall|setup> [--all]
```
- `run` — foreground (use this on WSL; systemd unreliable — wrap in tmux for persistence)
- `start`/`stop`/`restart`/`status` — service control
- `list` — all profiles + gateway status
- `install`/`uninstall` — register/remove systemd/launchd service
- `setup` — interactive messaging-platform setup
- `--all` — apply to every profile's gateway

---

## `hermes profile` — multi-tenant isolation

```
hermes profile <list|use|create|delete|show|alias|rename|export|import|install|update>
```
- `use <name>` — set sticky default profile
- `create <name>` — `--clone` `--clone-all` `--clone-from <source>`
- `delete <name>` — `-y` skip prompt
- `alias <name>` — wrapper script; `--remove` `--name NAME`
- `export <name> [-o FILE]` — backup to `.tar.gz`; `import <archive>` restores
- `install <source>` — install distribution: `--alias` `--force`; `update <name>` re-pulls

Profile selection: `--profile <name>` per-invocation, or `hermes profile use <name>` sticky, or `HERMES_PROFILE` env.

---

## `hermes model` — provider/model setup wizard

Interactive wizard for adding providers (full OAuth flows + API key entry).
**Gotcha:** `hermes model` (CLI) ADDS new providers; in-session `/model` only SWITCHES between already-configured ones.

## `hermes auth` — credential pools

```
hermes auth [list|add|remove|reset|status|logout|spotify]
```
- `add <provider> [--api-key KEY | --type oauth]`
- `remove <provider> <index>` · `reset <provider>` clears rate-limit cooldowns
- `status <provider>` · `logout <provider>` · `spotify` (PKCE)
- No subcommand = interactive pool manager

## `hermes fallback` — model fallback chain

```
hermes fallback <list|add|remove|clear>
```

## `hermes proxy` — local provider proxy

```
hermes proxy <start|status|providers>
```
- `start` — `--provider <nous|xai>` `--host <addr>` `--port <int>` (foreground)

## `hermes portal` — Nous Portal / Tool Gateway

```
hermes portal [status|open|tools]
```
- `status` (default) auth state + routing · `open` subscription page · `tools` list Tool Gateway partners

---

## `hermes mcp` — MCP servers

```
hermes mcp <picker|catalog|install|serve|add|remove|list|test|configure|login>
```
- (none)/`picker` — interactive catalog UI
- `catalog` — Nous-approved MCPs · `install <name>` from catalog
- `serve` — **run Hermes itself as an MCP server** (`-v`)
- `add <name>` — custom server: `--url` `--command` `--args` `--auth`
- `remove <name>` · `list` · `test <name>` (connection test) · `configure <name>` (toggle tools) · `login <name>` (force OAuth)

```bash
hermes mcp add myserver --command "node" --args "server.js"
hermes mcp add remote --url "https://host/mcp" --auth oauth
```

---

## `hermes skills` — skills lifecycle

```
hermes skills <browse|search|install|inspect|list|check|update|uninstall|reset|opt-out|opt-in|publish|snapshot|tap|config>
```
- `browse [--source <name>]` · `search <term> [--source <name>]`
- `install <skill-id>` (`--force`) · `inspect <skill-id>` (preview, no install)
- `list` · `check` (upstream updates) · `update` · `uninstall <skill>`
- `reset <skill>` clears `user_modified` (`--restore`) · `opt-out`/`opt-in` bundled-skill seeding · `publish` · `snapshot` · `tap` (custom sources) · `config` (per-platform enable/disable)

**Sources:** `official`, `skills-sh` (public directory), `well-known` (RFC 8615), `browse-sh` (site-specific).
All skills in `~/.hermes/skills/` auto-register as slash commands (`/skill-name args`).

## `hermes bundles` — skill bundles

```
hermes bundles <list|show|create|delete|reload>
```
- `create <name>` — `--skill <id>` (repeatable) `--description` `--instruction`

## `hermes curator` — autonomous skill curation

```
hermes curator <status|run|backup|rollback|pause|resume|pin|unpin|restore|archive|prune|list-archived>
```
- `run` — `--background` `--dry-run` · `rollback` — `--list` `--id <ts>` `-y` · `pin`/`unpin <skill>`

---

## `hermes cron` — scheduled jobs

```
hermes cron <list|create|edit|pause|resume|run|remove|status|tick>
```
- `create`/`add` — new job; `--skill <name>` repeatable
- `edit` — `--clear-skills` `--add-skill` `--remove-skill`
- `pause`/`resume` · `run` (trigger on next tick) · `remove` · `status` (scheduler) · `tick` (run due jobs once)

## `hermes webhook` — HTTP-triggered runs

```
hermes webhook <subscribe|list|remove|test>
```
- `subscribe <name>` — `--prompt` `--events` `--description` `--skills` `--deliver` `--deliver-chat-id` `--secret` `--deliver-only`
- Stored in `~/.hermes/webhook_subscriptions.json`

---

## `hermes config` — configuration management

```
hermes config <show|edit|set|path|env-path|check|migrate>
```
- `show` · `edit` (in `$EDITOR`) · `set <key> <value>`
- `path` (config file path) · `env-path` (`.env` path) · `check` (validate) · `migrate` (new-option setup)

```bash
hermes config set compression.threshold 0.6
hermes config set display.busy_input_mode queue
```

## `hermes doctor` / `status` / `dump` / `debug`

```
hermes doctor [--fix]                 # diagnostics; --fix auto-repairs
hermes status [--all] [--deep]        # --all = shareable redacted; --deep = longer checks
hermes dump [--show-keys]             # config dump; --show-keys shows redacted key prefixes
hermes debug share [--lines N] [--expire DAYS] [--local]   # share logs (default 200 lines, 7d expiry)
```

## `hermes logs`

```
hermes logs [agent|errors|gateway|gui|desktop|list] [-n N] [-f] [--level L] [--session ID] [--since 30m|1h|2d] [--component NAME]
```
Default log = `agent`, default lines = 50. Levels: DEBUG/INFO/WARNING/ERROR/CRITICAL.

---

## `hermes setup` — onboarding wizard

```
hermes setup [model|tts|terminal|gateway|tools|agent] [--quick] [--non-interactive] [--reset] [--portal]
```
- `--quick` only-missing · `--non-interactive` defaults/env · `--reset` reset first · `--portal` one-shot Nous Portal OAuth + Tool Gateway

## Other commands (brief)

- `hermes sessions <list|browse|export|delete|prune|stats|rename>` — `export <out> --session-id ID` (JSONL)
- `hermes send -t <platform[:chat_id|#channel]> ["msg"|-f FILE] [-s SUBJ] [-l] [-q] [--json]` — Telegram/Discord/Slack/Signal/SMS/WhatsApp-CloudAPI
- `hermes memory <setup|status|off>` — providers: honcho, openviking, mem0, hindsight, holographic, retaindb, byterover, supermemory
- `hermes tools [--summary]` — per-platform tool config
- `hermes kanban [--board <slug>] <init|boards|create|list|show|assign|claim|complete|block|dispatch|context|...>` — multi-agent task board (`kanban.db`)
- `hermes pairing <list|approve|revoke|clear-pending>` — messaging user approval
- `hermes hooks <list|test <event>|revoke|doctor>` — shell hooks (allowlist `~/.hermes/shell-hooks-allowlist.json`)
- `hermes plugins <install|update|remove|enable|disable|list>` — Git/`owner/repo` plugins (`--force`)
- `hermes secrets bitwarden|bw <setup|status|sync|install|disable>` — `--project-id` `--access-token` `--server-url`
- `hermes security audit [--json] [--fail-on LEVEL] [--skip-venv|--skip-plugins|--skip-mcp]` — OSV.dev scan
- `hermes checkpoints <status|list|prune|clear|clear-legacy>` — trajectory cache
- `hermes backup [-o PATH] [-q] [-l LABEL]` · `hermes import <zip> [-f]` — full backup/restore
- `hermes lsp <status|list|install|install-all|restart|which>` — language servers
- `hermes acp` — stdio server for editor integration (needs `pip install -e '.[acp]'`)
- `hermes dashboard [--port 9119] [--host 127.0.0.1] [--no-open] [--insecure] [--stop] [--status]`
- `hermes completion [bash|zsh|fish]` — shell completion to stdout
- `hermes update [--gateway|--check|--no-backup|--backup|--yes]` — auto-stashes, restarts gateway, detects pip vs git
- `hermes migrate xai [--apply] [--no-backup]` · `hermes claw migrate [...]` (OpenClaw import) · `hermes insights [--days N] [--source platform]`

---

## config.yaml — exact keys/structure

Location: `~/.hermes/config.yaml`

```yaml
compression:
  enabled: true              # default true
  threshold: 0.50            # compress at 50% of context limit (default 0.50)

auxiliary:
  compression:
    model: ""                # "" = use main chat model; else a cheap model e.g. google/gemini-3-flash-preview

display:
  busy_input_mode: "interrupt"   # "interrupt" (default) | "queue" | "steer"
  tool_preview_length: 0         # max chars in tool preview, 0 = no limit
  bell_on_complete: false        # terminal bell when background task finishes

quick_commands:
  status:
    type: exec
    command: systemctl status hermes-agent
  restart:
    type: alias
    target: /gateway restart

personalities:
  helpful: "You are a helpful, friendly AI assistant."
  pirate: "Arrr! Ye be talkin' to Captain Hermes..."

onboarding:
  seen:
    busy_input_prompt: true    # delete this key to re-show first-time busy-input hint
```

Compression preserves first 3 + last 20 turns during summarization.

---

## Environment Variables

| Var | Purpose |
|-----|---------|
| `HERMES_HOME` | Home dir (default `~/.hermes`) |
| `HERMES_PROFILE` | Active profile name |
| `HERMES_TUI` | Launch TUI (= `--tui`) |
| `HERMES_INFERENCE_MODEL` | Override model |
| `HERMES_KANBAN_BOARD` | Active kanban board |
| `HERMES_GATEWAY_NO_SUPERVISE` | Opt out of s6 auto-supervision |
| `HERMES_DASHBOARD_OAUTH_CLIENT_ID` | Dashboard OAuth client |

## File Paths

| Path | Contents |
|------|----------|
| `~/.hermes/config.yaml` | Main config |
| `~/.hermes/.env` | Credentials / API keys |
| `~/.hermes/state.db` | SQLite session/state store (metadata, history, lineage, FTS) |
| `~/.hermes/skills/` | Skills (auto-register as slash commands) |
| `~/.hermes/logs/` | agent/gateway/error logs |
| `~/.hermes/checkpoints/` | Session trajectory cache |
| `~/.hermes/kanban/` | Kanban boards |
| `~/.hermes/skill-bundles/` | Bundle manifests |
| `~/.hermes/webhook_subscriptions.json` | Dynamic webhooks |
| `~/.hermes/pairing/` | Messaging pairing data |
| `~/.hermes/shell-hooks-allowlist.json` | Approved shell hooks |

---

## Gotchas

- **Scripting:** use `hermes -z "..."` for pure final output (no banner/metadata); `-Q`/`--quiet` suppresses banner/spinners on `chat`.
- **`hermes model` vs `/model`:** CLI `model` adds providers; in-session `/model` only switches configured ones.
- **WSL gateway:** use `hermes gateway run` (not `start`) — systemd unreliable; wrap in tmux for persistence.
- **Session resume:** `--resume <id|title>`, `--continue [name]`, or `-r`/`-c`; sessions in `state.db`.
- **Max tool iterations:** `--max-turns` default `90`.
- **Backup exclusions:** SQLite sidecars (`*.db-wal`/`*.db-shm`/`*.db-journal`) and `checkpoints/` are NOT shipped with restore.
- **Slash commands case-insensitive** (`/HELP` == `/help`). Quiet mode is the default REPL behavior.
- **Run Hermes as an MCP server** to other agents via `hermes mcp serve`.
