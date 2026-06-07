# Hermes Agent — Profiles & Multi-Profile Gateways (Tech Reference)

Sources: https://hermes-agent.nousresearch.com/docs/user-guide/profiles , https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways

---

## 1. Profile CLI

### Create

```bash
hermes profile create mybot                                 # blank profile
hermes profile create work --clone                          # copy config only
hermes profile create backup --clone-all                    # copy everything
hermes profile create work --clone --clone-from coder       # clone from specific profile
hermes profile create researcher --description "Reads source code..."
```

### Manage

```bash
hermes profile list                    # all profiles + status
hermes profile show coder              # detailed info for one profile
hermes profile rename coder dev-bot    # rename (updates alias + service file)
hermes profile export coder            # -> coder.tar.gz
hermes profile import coder.tar.gz     # restore from archive
hermes profile delete coder            # delete (interactive confirm)
hermes profile delete coder --yes      # delete, no confirm
hermes profile use coder               # set sticky default
hermes profile describe                # set / auto-generate description
```

### Select a profile (per invocation)

```bash
coder chat                             # via profile alias (created automatically)
hermes -p coder chat                   # short flag
hermes --profile=coder doctor          # long form
hermes chat -p coder -q "hello"        # flag works in any position
```

### Per-profile config

```bash
coder setup                                                  # interactive: API keys + model
coder config set model.default anthropic/claude-sonnet-4
coder config set terminal.cwd /absolute/path/to/project
```

---

## 2. Per-profile isolation (state directory layout)

Each named profile gets its own state dir at `~/.hermes/profiles/<name>/`:

```
~/.hermes/profiles/<name>/
├── config.yaml        # model, provider, toolsets, gateway settings
├── .env               # API keys, bot tokens (chmod 600)
├── SOUL.md            # personality / system prompt
├── logs/gateway.log
└── (sessions dir, memory store, state DB, cron jobs, gateway PID file)
```

- **Default profile lives at `~/.hermes/` directly** (no `profiles/` nesting). It is named `default` in scripts.
- Isolation covers state: sessions, memory, state DB, cron, config, env, logs, gateway service.
- **Profiles are NOT a sandbox.** On the local backend the agent has full filesystem access as your user. Profile != workspace != sandbox. Asking the model "what directory are you in?" is not a reliable isolation test.

---

## 3. config.yaml keys (confirmed)

```yaml
model:
  default: anthropic/claude-sonnet-4
terminal:
  backend: local
  cwd: /absolute/path/to/project   # cwd: "." = dir Hermes was launched from, NOT the profile dir
```

Set via CLI: `<profile> config set <dotted.key> <value>`.

---

## 4. Environment variables

- `HERMES_HOME` — controls which profile's state dir is active. Set automatically by the per-profile wrapper/alias scripts; you normally do not set it by hand.
- Per-platform bot tokens live in each profile's `.env`: `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `SLACK_*`, WhatsApp, Signal.

---

## 5. Multi-profile gateways

### Setup

```bash
hermes profile create coder
hermes profile create personal-bot
hermes profile create research
coder setup
personal-bot setup
research setup
```

### Per-profile gateway control

```bash
<profile> gateway run        # foreground
<profile> gateway start      # managed service (start)
<profile> gateway install    # create systemd/launchd service
<profile> gateway stop
<profile> gateway restart
<profile> gateway status
```

`<profile> gateway <action>` is exactly equivalent to `hermes -p <profile> gateway <action>`.

### Service file locations

| Platform | Path |
|----------|------|
| macOS    | `~/Library/LaunchAgents/ai.hermes.gateway-<profile>.plist` |
| Linux    | `~/.config/systemd/user/hermes-gateway-<profile>.service`  |

Default profile uses historical names: `ai.hermes.gateway.plist` / `hermes-gateway.service`.

### Logs

```bash
# default profile
~/.hermes/logs/gateway.log
# named profile
~/.hermes/profiles/<name>/logs/gateway.log
# stream all
tail -f ~/.hermes/logs/gateway.log ~/.hermes/profiles/*/logs/gateway.log
```

### Multi-gateway wrapper (from docs)

```sh
#!/bin/sh
set -eu
profiles="default coder personal-bot research"

run_for_profile() {
  profile="$1"; action="$2"
  if [ "$profile" = "default" ]; then
    hermes gateway "$action"
  else
    hermes -p "$profile" gateway "$action"
  fi
}
# usage: hermes-gateways {start|stop|restart|status|list}
```

### Force service reset

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/ai.hermes.gateway-<profile>.plist && \
launchctl load   ~/Library/LaunchAgents/ai.hermes.gateway-<profile>.plist
# Linux
systemctl --user restart hermes-gateway-<profile>.service
```

---

## 6. Gotchas

1. **Token uniqueness (hard constraint):** Each profile MUST use unique bot tokens per platform. If two profiles share a Telegram/Discord/Slack/WhatsApp/Signal token, the second gateway refuses to start with an error naming the conflicting profile. Audit:
   ```bash
   grep -H 'TELEGRAM_BOT_TOKEN\|DISCORD_BOT_TOKEN' \
     ~/.hermes/.env ~/.hermes/profiles/*/.env
   ```
2. **Cannot delete the default profile** (`~/.hermes`).
3. **SOUL.md** changes take effect only on a NEW session; existing sessions keep the old prompt state.
4. **`cwd: "."`** = launch directory, not the profile directory; use an absolute path for predictability.
5. **No filesystem sandbox** from profiles — see §2.
6. **Distinct port per profile: NOT documented.** The multi-profile-gateways page explicitly contains no `config.yaml`/`.env` key for setting a per-profile gateway listen port (no `gateway.port`, no `HERMES_GATEWAY_PORT` found in either page). Gateways are differentiated by separate state dirs + separate service files + unique bot tokens, not by a documented HTTP port knob. Tried sibling pages `/docs/user-guide/gateway` and `/docs/user-guide/gateways` — both 404. If a port is needed, it is not surfaced in the two authoritative profile docs.

## 7. Misc

```bash
eval "$(hermes completion bash)"   # tab completion (add to ~/.bashrc)
eval "$(hermes completion zsh)"    # add to ~/.zshrc
hermes -p <profile> doctor         # health check
```
