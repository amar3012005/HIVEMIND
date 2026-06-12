# Slack in HIVEMIND — Connector, Bot & Tools

> Slack is HIVEMIND's deepest connector: native bot OAuth (NOT Nango),
> message ingestion, live agent tools, and a Socket-Mode bot that answers
> `@HIVEMIND` mentions inside Slack with the full react agent (recall, save,
> uploads, draft-approval). One Slack app — **DAVINCI AI** (`A0AQTN6JMRB`,
> bot user `U0B2LA6RSLB`) — powers all of it.
>
> Verified against prod 2026-06-12. Commits: `49991f1`, `2781528`,
> `de1bd1e`, `03d9b96`, `fa979af`, `9f3c90c`, `088c11e`.
>
> **STATUS: mention-answering is LIVE.** `@HIVEMIND what do u know about
> Uwe?` → real recall answer in-channel. The production event path is the
> **HTTP Events API** (signing-secret verified); Socket Mode remains as a
> redundant fallback. See §3.

---

## 1. Why Slack is NOT on Nango

Slack needs BOTH a **bot token** (`xoxb`/`xoxe.xoxb` — post, history,
mentions) and a **user token** (`xoxp` — `search.messages` is user-scope
only). Nango's slack template was user-token-only, so Slack moved to a
native OAuth v2 flow that captures both:

```
FE "Connect Slack" → control-plane POST /v1/connectors/slack/start
  → slack.com/oauth/v2/authorize  (bot scopes + user_scope=search:read)
  → GET /v1/connectors/slack/callback → oauth.v2.access
  → PlatformIntegration row:
      accessTokenEncrypted                    = BOT token (AES-256-GCM)
      refreshTokenEncrypted                   = rotation refresh token
      connectorMetadata.provider_metadata.{user_access_token, team_id, …}
```

Bot scopes: `channels:history channels:read groups:history im:history
mpim:history users:read users:read.email team:read chat:write
app_mentions:read files:read`. User scope: `search:read`.

### Token rotation — the trap that bit us
Workspace tokens are **rotating** (`xoxe.…`, ~12 h lifetime). Any static
copy (env vars like `SLACK_BOT_TOKEN_<TEAM>`) silently dies. The live token
lives ONLY in `PlatformIntegration`, refreshed via
`oauth.v2.access grant_type=refresh_token`. Core exposes it internally:

```
GET /api/connectors/slack/bot-token?team_id=<T…>     (master-key only)
→ validates with auth.test, refreshes + persists if stale, returns the token
```

## 2. The five Slack surfaces

| Surface | Entry | Token source |
|---|---|---|
| **Status / FE card** | `GET /api/connectors/slack/status` + `/v1/connectors` | PlatformIntegration |
| **Ingestion sync** | `POST /api/connectors/slack/sync` (manual) + sync-scheduler (cron) | `ConnectorStore.getAccessToken` (Nango-first → native fallback) |
| **Chat agent tools** | native toolkit group `slack` — `slack_search_messages`, `slack_list_channels`, `slack_channel_history`, `slack_read_thread`, `slack_post_message` (draft-approval gated) | SlackBridge → ConnectorStore |
| **Digital-employee actions** | `POST /api/employees/slack-action` (slack_post/react/search/history; persona via `chat:write.customize`) | installer's bot token |
| **The bot ("@HIVEMIND … ?")** | Socket Mode → event-ingest → react agent (below) | live token via bot-token endpoint |

## 3. The mention-answering pipeline (LIVE — HTTP Events API)

The app turned out to be configured in **HTTP Events mode** (a Request URL in
Event Subscriptions), NOT Socket Mode — which is why the socket gateway never
received anything. This is now the production path:

```
human posts "@HIVEMIND what do we know about X?"
  → Slack POSTs the event to
      https://api.hivemind.davinciai.eu:8040/v1/connectors/slack/events
  → control-plane (control-plane-s0k0…)
      - HMAC verify (X-Slack-Signature, timing-safe, 300 s skew window)
      - url_verification handshake answered (this is what "Retry → Verified ✓" hits)
      - ack 200 within 3 s, forward async →
  → core POST /api/connectors/slack/event-ingest   (master key)
      - resolves the OAuth owner from team_id (PlatformIntegration)
      - resolves the ASKING Slack user → HIVEMIND user via email (their recall scope)
      - posts "🧠 Thinking…" placeholder
      - runReactAgentV2 (gpt-oss-120b): full recall + save + tools + draft-approval
      - chat.update → the placeholder becomes the answer, in-thread
      - per-conversation history (12 turns) for follow-ups
      - files in the message → downloaded with the bot token → /api/knowledge/upload (Docling)
      - "save this" flows → Block-Kit project picker → /api/connectors/slack/interactivity
```

App config (Event Subscriptions page): Request URL as above (**Verified ✓**),
bot events `app_mention`, `message.im`, `message.channels`.

### The signing secret — where it lives
`/v1/connectors/slack/events` verifies HMAC with the app's Signing Secret.
Running containers cannot gain new env vars without a recreate, so the
handler resolves it as `process.env.SLACK_SIGNING_SECRET` **falling back to
the file `/opt/HIVEMIND/core/.slack-signing-secret`** (gitignored, `600`
perms, read per-request — drop-in changes need no restart). Installed and
handshake-verified 2026-06-12 (signed challenge echoed; forged signature →
401).

### Socket Mode (redundant fallback)
The employees-service Bolt gateway (slack/gateway.py) stays fully wired:
live-token `authorize()` (10-min cache, refetch-on-fail), Redis dedup,
employee routing, and `_forward_to_core()` for unrouted mentions/DMs into the
same event-ingest. If the app is ever flipped to Socket Mode, everything
works without code changes. Note both paths converge on event-ingest, which
dedups by `team_id:event_ts` — running both simultaneously is safe.

## 4. Ingestion quality guards

- `email-cleaner`-style noise control for Slack lives in the adapter
  (skips joins/leaves/bot echoes) + `memory/normalizers/slack.js`.
- Event-ingest dedups by `team_id:event_ts` (bounded set, Slack retries).
- The gateway never replies to bot-authored messages (`bot_id`/`app_id`
  guard) — Slack also never emits `app_mention` for bot messages, which is
  why synthetic "post as bot mentioning the bot" tests cannot exercise the
  mention leg; only a human mention can.

## 5. The ten bugs that made Slack "randomly broken" (all fixed)

1. `sync-scheduler` passed `orgId:null` → Prisma threw on the
   NangoConnection lookup → **every scheduled sync failed** → FE Error/Retry.
2. `slack-live` MCP catalog entry was `auth_strategy:nango` after OAuth went
   native → token-resolution spam + dead agent tools. Now
   `transport:internal`, healthy ⇔ native token resolves.
3. Dead Nango slack connections retried forever (424) → self-heal flips
   them to `error`.
4. `SLACK_SIGNING_SECRET` missing → public events path 503 → moved to
   Socket Mode.
5. Gateway only started Socket workspaces from employees' `slack_team_id`
   (all null) → "0 workspaces" → env-declared workspaces
   (`SLACK_APP_TOKEN_<TEAM>`) now connect even with zero employees.
6. `SLACK_CLIENT_ID/SECRET` env made Bolt auto-enable its file
   InstallationStore and **ignore the bot token** → every event failed
   authorize → explicit `authorize()` pinned to our token.
7. The pinned env token itself was a stale rotating token (`invalid_auth`)
   → dynamic `token_provider` fetching the live token from core, 10-min
   cache, force-refetch on auth failure.
8. Mentions with no employee match were silently dropped → unrouted
   mentions/DMs now forward to core's event-ingest (the full agent).
9. The app was actually in **HTTP Events mode** (Request URL configured)
   while we debugged Socket Mode — the webhook 503'd for a missing signing
   secret, so Slack's URL verification failed and delivery stayed off. Fixed
   via the on-disk signing-secret fallback (`fa979af`) + dashboard "Retry".
10. **Connect button 403 for non-admins**: the FE scope selector preloads
   from existing connector rows, so an admin's org-wide Slack row made every
   viewer send `target_scope:'organization'` → `assertPermission` threw a
   bare 403 "Forbidden" dead-end. The FE now retries any `/start` 403 with
   `target_scope:'personal'` + an explanatory toast (`9f3c90c`, `088c11e`) —
   a personal start has no 403 path, so the retry is provably safe.

## 6. Ops runbook

```bash
# Events flowing? (the production signal)
docker logs --since 10m control-plane-s0k0… 2>&1 | grep slack-events
#   "[slack-events] inbound event_callback type=app_mention …" = healthy

# Webhook handshake healthy? (signed exactly like Slack's Retry button)
TS=$(date +%s); BODY='{"type":"url_verification","challenge":"probe"}'
SIG="v0=$(printf 'v0:%s:%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$(cat /opt/HIVEMIND/core/.slack-signing-secret)" -hex | awk '{print $NF}')"
curl -sk -X POST https://api.hivemind.davinciai.eu:8040/v1/connectors/slack/events \
  -H "content-type: application/json" -H "x-slack-request-timestamp: $TS" \
  -H "x-slack-signature: $SIG" -d "$BODY"        # → {"challenge":"probe"}

# Socket alive? (fallback path)
docker logs hm-employees 2>&1 | grep -E "Bolt app is running|socket-mode started" | tail -2

# Live bot token (also proves refresh path)
curl "http://localhost:3000/api/connectors/slack/bot-token?team_id=T0AF7AU1B6D" -H "X-API-Key: $MASTER"

# Are events being delivered? Post anything to a bot channel, then:
docker logs --since 30s hm-employees 2>&1 | grep inbound
#   lines  → subscriptions ON, pipeline live
#   silence→ Event Subscriptions still off in the Slack app dashboard

# Exercise the FULL answer pipeline without Slack (master-key, real reply posts!)
curl -X POST http://localhost:3000/api/connectors/slack/event-ingest \
  -H "X-API-Key: $MASTER" -H 'content-type: application/json' \
  -d '{"team_id":"T0AF7AU1B6D","event_type":"app_mention",
       "event":{"type":"app_mention","channel":"<C…>","user":"<U…>",
                "text":"<@U0B2LA6RSLB> what do you know about X?","ts":"123.456","event_ts":"123.456"}}'

# Sync state
SELECT sync_status, last_error_message FROM hivemind.platform_integrations WHERE platform_type='slack';
```

Identity cheat-sheet: workspace `T0AF7AU1B6D` (davinci-ai.slack.com) · app
`A0AQTN6JMRB` · bot user `U0B2LA6RSLB` · human admin `U0AESBE05L6`.
