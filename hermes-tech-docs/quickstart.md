# Hermes Agent — Quickstart & Core Concepts (Tech Reference)

**Sources:** https://hermes-agent.nousresearch.com/docs/getting-started/quickstart , https://hermes-agent.nousresearch.com/docs/getting-started/learning-path

> Distilled from the two official docs pages above. Both loaded (no 404s). Items marked `[not in docs]` were NOT documented on these pages — do not assume.

---

## 1. Install

Linux / macOS / WSL2 / Android (Termux):
```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
source ~/.bashrc   # or: source ~/.zshrc
```

Windows (PowerShell):
```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

Desktop installer: https://hermes-agent.nousresearch.com/desktop

---

## 2. Minimal Happy Path (first agent)

The docs' explicit guidance: **"Get one clean conversation working first, then layer on gateway, cron, skills, voice, or routing."**

For first-time users the recommended entry point is:
```bash
hermes setup --portal
```
This is the Nous Portal quick setup: **"one OAuth covers a model plus the four Tool Gateway tools."** After setup, start chatting:
```bash
hermes            # classic CLI
hermes --tui      # modern TUI
```

Beginner path (~1h): Installation → Quickstart → CLI Usage → Configuration.

---

## 3. CLI Commands

| Command | Purpose |
|---------|---------|
| `hermes` | Start chatting (classic CLI) |
| `hermes --tui` | Modern TUI interface |
| `hermes --continue` | Resume last session (depends on profile matching) |
| `hermes model` | Choose LLM provider/model |
| `hermes setup` | Full setup wizard |
| `hermes setup --portal` | Quick Nous Portal OAuth setup (recommended first run) |
| `hermes doctor` | Diagnose issues |
| `hermes gateway setup` | Configure messaging platforms (Telegram/Discord) |
| `hermes skills browse` | Browse available skills |
| `hermes tools` | Configure tool access |
| `hermes config set <key> <value>` | Set config / secrets (see below) |

In-session slash commands (type `/` for autocomplete): `/help`, `/tools`, `/model`, `/personality [name]`, `/save`, `/voice on`.

Interrupt a running task: type a new message + Enter, or `Ctrl+C`.

Multi-line input: `Alt+Enter` or `Ctrl+J` (all terminals); `Shift+Enter` on Kitty/foot/WezTerm/Ghostty (needs Kitty protocol on iTerm2/Alacritty/VS Code).

---

## 4. Configuration

Storage split:
- **Secrets/tokens** → `~/.hermes/.env`
- **Non-secret settings** → `~/.hermes/config.yaml`

Set values via CLI (writes to the right file automatically):
```bash
hermes config set model anthropic/claude-opus-4.6
hermes config set terminal.backend docker      # sandboxed
hermes config set terminal.backend ssh         # remote server
hermes config set OPENROUTER_API_KEY sk-or-...  # secret -> .env
```

Known config keys (from docs): `model` (string, `provider/model-id` form), `terminal.backend` (`docker` | `ssh`), `mcp_servers` (map). A full `config.yaml` template is **[not in docs]** — set keys via `hermes config set`.

### MCP server config (only structured YAML example given)
```yaml
mcp_servers:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_xxx"
```

### Provider API key env var names
| Provider | Env var |
|----------|---------|
| OpenRouter | `OPENROUTER_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Google AI Studio | `GOOGLE_API_KEY` / `GEMINI_API_KEY` |
| xAI | `XAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |

---

## 5. Core Concepts (terminology)

- **Sessions** — conversation management; `hermes --continue` resumes the last one (profile must match).
- **Delegation** — spawn sub-agents for parallel work.
- **Provider Routing** — route requests across multiple LLM providers.
- **Tools** — built-in callable tools: file I/O, search, shell, image, TTS, browser.
- **Plugins** — custom tool extensions.
- **MCP (Model Context Protocol)** — connect to external tool servers (see `mcp_servers` config).
- **Memory** — persistent memory across sessions.
- **Context Files** — feed files/directories into conversations.
- **Hooks** — event-driven callbacks and middleware.
- **Cron** — schedule recurring agent tasks.
- **Batch Processing** — process multiple inputs in bulk.
- **Code Execution** — Python scripts that call Hermes tools programmatically (Python library integration supported; exact API surface **[not in docs]**).
- **Gateway** — messaging platform integration (Telegram, Discord) via `hermes gateway setup`.
- **Atropos RL Environments** — reinforcement-learning training (external GitHub).

Learning path tiers: Beginner ~1h; Intermediate ~2–3h (Sessions → Messaging → Tools → Skills → Memory → Cron); Advanced ~4–6h (Architecture → Adding Tools → Creating Skills → Contributing).

---

## 6. Gotchas

1. **Minimum context: 64,000 tokens.** Models below this are rejected at startup.
2. Build incrementally — one clean conversation first, then gateway/cron/skills/voice/routing.
3. `hermes --continue` only works if the active profile matches the session's profile.
4. `terminal.backend` must be `docker` (sandboxed) or `ssh` (remote) — pick deliberately.
5. Voice mode is an optional extra install:
   ```bash
   cd ~/.hermes/hermes-agent
   uv pip install -e ".[voice]"
   ```
   Then `/voice on` in CLI; record with `Ctrl+B`.
