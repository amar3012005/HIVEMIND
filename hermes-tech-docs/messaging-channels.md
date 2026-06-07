# Hermes Agent — Messaging Channels (Slack / Telegram / Discord)

**Sources:** https://hermes-agent.nousresearch.com/docs/user-guide/messaging/ · …/messaging/telegram/ · …/messaging/discord/ · …/messaging/slack/  (NOTE: `/docs/user-guide/gateway/` → 404; gateway content lives under the messaging pages.)

---

## TL;DR — what enables each platform

A platform is driven by **its credential env var being set**. Set the token(s), set the allowlist, then run the gateway. The interactive wizard (`hermes gateway setup`) writes these for you, but they are plain env vars you can set programmatically with no custom hacks.

| Platform | Credential env var(s) that enable it | Allowlist (required for access) |
|----------|--------------------------------------|---------------------------------|
| Telegram | `TELEGRAM_BOT_TOKEN` | `TELEGRAM_ALLOWED_USERS` (numeric IDs, comma-sep) |
| Discord  | `DISCORD_BOT_TOKEN`  | `DISCORD_ALLOWED_USERS` **or** `DISCORD_ALLOWED_ROLES` (else **all users denied**) |
| Slack    | `SLACK_BOT_TOKEN` (`xoxb-`) **+** `SLACK_APP_TOKEN` (`xapp-`) | `SLACK_ALLOWED_USERS` (member IDs, e.g. `U01ABC2DEF3`) |

> The docs do not state an explicit "token present ⇒ auto-enabled" rule in prose; in practice the gateway activates a platform when its credentials are configured. `hermes gateway setup` shows which platforms are already configured and offers to start/restart the gateway.

Cross-platform allowlist controls:
- `GATEWAY_ALLOWED_USERS=123456789,987654321` — applies across all platforms
- `GATEWAY_ALLOW_ALL_USERS=true` — open access (NOT recommended)

---

## Gateway CLI

```bash
hermes gateway              # Run gateway in foreground
hermes gateway setup        # Interactive wizard: arrow-key platform select, shows configured platforms, start/restart on exit
hermes gateway install      # Install as a user service (Linux: optional --system for system service)
hermes gateway start        # Start the service
hermes gateway stop         # Stop the service
hermes gateway status       # Service status
hermes -p <profile> gateway # Run a named profile's gateway
```
(`restart` / `--profile` flag not documented; use `-p <profile>` form for profiles.)

Per-platform toolset identifiers (full tools incl. terminal): `hermes-telegram`, `hermes-discord`, `hermes-slack`.

---

## TELEGRAM

Token from `@BotFather` (`t.me/BotFather` → `/newbot` → name + username ending in `bot`). Token format: `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`.

Env vars:
```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdef...     # required — enables Telegram
TELEGRAM_ALLOWED_USERS=123456789,987654321 # numeric user IDs (NOT @username)
TELEGRAM_HOME_CHANNEL=<chat_id>            # deliver target for scheduled/cron task results
TELEGRAM_GROUP_ALLOWED_USERS=...           # user IDs allowed in groups only
TELEGRAM_GROUP_ALLOWED_CHATS=...           # group chat IDs where any member can interact
TELEGRAM_GUEST_MODE=true                   # allow non-allowlisted groups on explicit @mention
TELEGRAM_REACTIONS=true                    # emoji reactions
TELEGRAM_WEBHOOK_URL=https://...           # webhook mode (cloud); else polling (default)
TELEGRAM_WEBHOOK_SECRET=...                # webhook verification token
TELEGRAM_PROXY=socks5://...                # or http:// / https://
```

config.yaml:
```yaml
telegram:
  require_mention: true          # require @mention in groups
  exclusive_bot_mentions: true   # only the mentioned bot responds
  mention_patterns: ["^\\s*chompy\\b"]
  ignored_threads: [31, "42"]
  reactions: true
  channel_prompts:
    "-1001234567890": "Custom system prompt"
```

Deliver targets: DMs · groups (bot admin or privacy mode off) · home channel (cron results, set via `/sethome`) · forum topics.

Gotchas:
- **Group Privacy mode is ON by default** → bot only sees `/`-commands and direct replies. Disable in BotFather → Bot Settings → Group Privacy.
- After changing privacy: **remove bot from group and re-add it**.
- Use numeric user ID, never `@username`.
- File size: public Bot API caps 20 MB; local `telegram-bot-api` server raises to 2 GB.

---

## DISCORD

Token from Discord Developer Portal. **Token is shown once — reset if lost.**

Required gateway intents (toggle in Developer Portal):
- **Message Content Intent** — without it, message events arrive but text is empty ("bot literally cannot see what you typed").
- **Server Members Intent** — needed to resolve usernames for the allowed-users list.

Env vars:
```bash
DISCORD_BOT_TOKEN=...                    # required — enables Discord
DISCORD_ALLOWED_USERS=123456789012345678 # comma-sep user IDs
DISCORD_ALLOWED_ROLES=...                # role-based access (alternative to user IDs)
DISCORD_HOME_CHANNEL=<channel_id>        # deliver target for proactive/scheduled messages
DISCORD_REQUIRE_MENTION=true             # gate to @mentions in server channels (default true)
DISCORD_FREE_RESPONSE_CHANNELS=...       # channel IDs where bot responds without @mention
```
**Without `DISCORD_ALLOWED_USERS` or `DISCORD_ALLOWED_ROLES`, the gateway denies all users.**

config.yaml keys: `discord.require_mention`, `discord.auto_thread`, `discord.reactions`, `discord.channel_prompts`, `group_sessions_per_user`.

Invite permission integers:
- Minimal `117760` — View Channels, Send Messages, Read Message History, Attach Files
- Recommended `274878286912` — adds Embed Links, Thread Messaging, Add Reactions

Deliver targets: server channels · DMs · home channel (set via `/sethome` slash command).

Advanced per-platform allow config (gateway-config.yaml):
```yaml
gateway:
  platforms:
    discord:
      extra:
        allow_from: ["111", "222", "333"]
        allow_admin_from: ["111"]
        user_allowed_commands: [status, model]
        group_allow_admin_from: ["111"]
        group_user_allowed_commands: [status]
```

---

## SLACK

Uses **Socket Mode** (WebSockets) — no public HTTP endpoint needed.

Env vars:
```bash
SLACK_BOT_TOKEN=xoxb-...        # required — Bot token
SLACK_APP_TOKEN=xapp-...        # required — App-level token (needs connections:write scope)
SLACK_ALLOWED_USERS=U01ABC2DEF3 # comma-sep member IDs
SLACK_HOME_CHANNEL=<channel_id> # deliver target for scheduled messages
SLACK_HOME_CHANNEL_NAME=<name>  # human-readable channel name
```

Bot Token scopes:
- `chat:write`, `app_mentions:read`, `channels:read`, `users:read`, `files:read`, `files:write`
- `channels:history` + `groups:history` — **required or bot will NOT receive channel messages**
- `im:history`, `im:read`, `im:write` — DM support
- App-Level Token scope: `connections:write` (for Socket Mode)

Event subscriptions: `message.im`, `message.channels`, `message.groups`, `app_mention`.

CLI:
```bash
hermes slack manifest --write   # write the Slack app manifest
hermes gateway setup
hermes gateway
hermes gateway install
```

Gotchas:
- Enable **Messages Tab** in App Home, or DMs are completely blocked.
- Works in DMs but not channels ⇒ you forgot `message.channels` (+ `channels:history`).
- **Must reinstall the app** after changing scopes or event subscriptions.
- Invite the bot to each channel: `/invite @Hermes Agent`.

---

## Session reset policy (`~/.hermes/gateway.json`)

```json
{
  "reset_by_platform": {
    "telegram": { "mode": "idle", "idle_minutes": 240 },
    "discord":  { "mode": "idle", "idle_minutes": 60 }
  }
}
```
Modes: `daily` (configurable hour) · `idle` (configurable minutes) · `both` (whichever triggers first).
