# Google Workspace MCP — Architecture + Operations

> How HIVEMIND talks to Gmail / Drive / Calendar / Docs / Sheets / Slides / Contacts / Tasks / Forms.
> Single OAuth, sidecar-bridged tool surface, per-tenant token forwarding.

---

## 1. Why a sidecar instead of native API clients

Initial impulse: write a `googleapis` Node client per service inside HIVEMIND core. Rejected because:

| Problem | Effect |
|---------|--------|
| 10 services × dozens of endpoints | Hundreds of hand-maintained client methods |
| Google SDK version churn | Constant breaking-change firefighting in core |
| Each service has its own auth quirks | Tokens, scopes, refresh flow logic duplicated |
| LLM agents prefer tool descriptors | Native code can't expose itself as MCP tools to Claude / Cursor / etc. without wrapper work |

**Solution**: use the open-source [`taylorwilsdon/google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp) project as a sidecar. Battle-tested 80+ tools across all 10 Google services. HIVEMIND owns the OAuth + token storage; the sidecar handles API specifics.

```
┌────────────────────────────────────────────────────────────────────┐
│                    HIVEMIND CORE (Node.js)                         │
│                                                                    │
│  - OAuth flow → exchange code → encrypted token in Prisma          │
│  - User clicks Connect → /api/connectors/gmail/connect             │
│  - Per-service platform_integrations row (gmail, google_drive…)    │
│  - Sync engine adapters call WorkspaceMcpBridge.callTool(…)        │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
                              │
                              │  HTTP POST /mcp/tools/call
                              │  Authorization: Bearer ya29.<google-access-token>
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│   workspace-mcp SIDECAR  (Python, EXTERNAL_OAUTH21_PROVIDER mode)  │
│                                                                    │
│  - taylorwilsdon/google_workspace_mcp                              │
│  - Stateless mode (WORKSPACE_MCP_STATELESS_MODE=true)              │
│  - No persisted user state; every call carries its own Bearer      │
│  - 80+ tools across Gmail / Drive / Calendar / Docs / Sheets /     │
│    Slides / Contacts / Chat / Tasks / Forms                        │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
                              │
                              │  HTTPS to *.googleapis.com
                              ▼
                       Google Workspace APIs
```

---

## 2. Sidecar deployment

Container: `workspace-mcp` running alongside `hm-core` on Coolify VPS.

```yaml
# docker-compose.yml (relevant snippet)
workspace-mcp:
  image: ghcr.io/taylorwilsdon/google_workspace_mcp:latest
  environment:
    WORKSPACE_MCP_STATELESS_MODE: "true"
    WORKSPACE_MCP_EXTERNAL_OAUTH21_PROVIDER: "true"
    WORKSPACE_MCP_BIND: "0.0.0.0:8000"
    WORKSPACE_MCP_LOG_LEVEL: "info"
  networks:
    - hmtest
  expose:
    - "8000"
```

HIVEMIND core resolves the sidecar via `WORKSPACE_MCP_URL=http://workspace-mcp:8000` (env var; defaults to that hostname on the docker network).

Health check:
```bash
docker exec hm-core curl -fsS http://workspace-mcp:8000/health
```

Restart on config drift:
```bash
docker restart workspace-mcp
```

---

## 3. Auth model — HIVEMIND owns the tokens

The sidecar is stateless. Token plumbing lives in HIVEMIND:

| Storage | Encrypted token in Prisma `platform_integrations` table |
| Key | `userId + provider` (one row per Google service per user) |
| Encryption | AES-256-GCM, key from `HIVEMIND_TOKEN_ENCRYPTION_KEY` |
| Refresh | Auto-refresh inside `WorkspaceMcpBridge.getAccessToken` when < 5 min remaining |
| Forwarding | Decrypted Bearer token sent on every `POST /mcp/tools/call` |

### Why this is multi-tenant safe

1. Sidecar process never sees a database, never persists token state
2. Every call independently authenticated — no in-memory tenant context
3. Bearer token IS the tenancy boundary
4. `WORKSPACE_MCP_STATELESS_MODE=true` is enforced — sidecar refuses to cache

### Why one OAuth grants 10 services

`/api/connectors/gmail/connect` requests a Google scope per checked service:

```
gmail.readonly
drive.readonly
calendar.readonly
documents.readonly
spreadsheets.readonly
presentations.readonly
contacts.readonly
chat.messages.readonly
tasks.readonly
forms.body.readonly
```

After consent, HIVEMIND splits the granted-scopes set into per-service rows so each can be disconnected independently. **Important**: previous bug where `include_granted_scopes=true` caused scope leak across services was fixed in commit `33342dd` — see `core/src/connectors/providers/gmail/oauth.js`.

---

## 4. Bridge code — `workspace-mcp-bridge.js`

`core/src/connectors/providers/google/workspace-mcp-bridge.js`

### Public methods

```js
const bridge = new WorkspaceMcpBridge({ prisma, decryptToken, refreshOAuthToken, mcpUrl });

// Get a fresh access token (auto-refresh if needed)
const token = await bridge.getAccessToken(userId);

// Call any workspace-mcp tool with the user's token forwarded
const result = await bridge.callTool(userId, 'gmail_search_messages', {
  query: 'from:user@example.com after:2024/01/01',
  max_results: 20,
});

// List all available tools (debug)
const tools = await bridge.listTools();
```

### Internals

1. `getAccessToken(userId)`:
   - Query `platform_integrations` for ANY of the 10 Google service rows
   - Pick the most recently updated (gmail is always present if any Google connected)
   - Check expiry: if < 5 min, call `refreshOAuthToken(connector)` → updated row
   - Return decrypted access_token

2. `callTool(userId, name, args)`:
   - Get token via above
   - `POST {mcpUrl}/mcp/tools/call` with body `{ name, arguments }`
   - `Authorization: Bearer <token>` header
   - 60s timeout
   - Parses MCP-shape response: `result.content[].text` joined into one string

3. `listTools()`:
   - `POST {mcpUrl}/mcp/tools/list`
   - Returns the sidecar's full tool catalog

---

## 5. Tool surface (80+)

Sample — full list via `bridge.listTools()`:

| Service | Examples |
|---------|----------|
| Gmail | `gmail_search_messages`, `gmail_send_message`, `gmail_get_thread`, `gmail_modify_labels`, `gmail_create_draft`, `gmail_list_labels`, `gmail_create_filter` |
| Drive | `search_drive_files`, `get_drive_file`, `list_drive_folders`, `create_drive_file`, `move_drive_file`, `share_drive_file`, `download_drive_file` |
| Calendar | `get_events`, `list_calendars`, `create_event`, `update_event`, `delete_event`, `suggest_time`, `respond_to_event` |
| Docs | `read_doc`, `create_doc`, `append_text`, `find_and_replace`, `get_doc_metadata` |
| Sheets | `read_sheet`, `write_sheet_range`, `append_sheet_rows`, `create_sheet`, `format_sheet_range` |
| Slides | `read_presentation`, `create_slide`, `update_slide_text` |
| Contacts | `list_contacts`, `search_contacts`, `create_contact`, `update_contact` |
| Chat | `list_chat_messages`, `send_chat_message`, `list_chat_spaces` |
| Tasks | `list_task_lists`, `list_tasks`, `create_task`, `complete_task` |
| Forms | `get_form`, `list_form_responses` |

These tools are NOT exposed to MCP clients directly. HIVEMIND core calls them internally on behalf of sync adapters + Talk-to-HIVE live queries. Exposing them via HIVEMIND's MCP server (so AI agents can use them) is on the roadmap — see Section 11.

---

## 6. Two paths into the bridge

### Path A — Sync engine adapters
Used by background workers + `/api/connectors/*/sync` endpoints. Adapters
fetch + normalize Google data into HIVEMIND memory schema.

```
GmailAdapter.fetchInitial({ accessToken, cursor, context })
  → directly hits gmail.googleapis.com (own client, not via bridge)
  
GoogleDriveDocsAdapter.fetchInitial({ accessToken, cursor, context })
  → bridge.callTool(userId, 'search_drive_files', { ... })
  → bridge.callTool(userId, 'get_drive_file', { ... })

GoogleCalendarAdapter.fetchInitial(...)
  → bridge.callTool(userId, 'get_events', { ... })
```

**Note**: Gmail adapter still uses the native Gmail API directly (faster, no IPC). Drive/Calendar/Docs/Sheets/Slides go through the bridge.

### Path B — Live-query router (Talk-to-HIVE)
Used when chat user asks "what's on my calendar tomorrow" / "find Q3 budget doc". Memory recall comes up short → router falls back to live Google query.

```
ChatHandler ('what meetings do I have this week?')
  → memory recall returns 0 high-confidence hits
  → LiveQueryRouter.classify() detects 'calendar' intent
  → bridge.callTool(userId, 'get_events', { date_range: 'this week' })
  → result formatted into chat reply
  → optionally ingested as memory tagged 'live-calendar'
```

`core/src/connectors/providers/google/live-query-router.js` owns this fallback.

---

## 7. Per-service connect / disconnect

User-facing flow on `/hivemind/app/connectors`:

```
Click "Connect Gmail" → /api/connectors/gmail/connect?services=gmail
  → Google OAuth consent screen → exchange code
  → upsert platform_integrations row(s) for granted services
  → redirect back to FE w/ ?connected=gmail

Click "Disconnect Drive" → /api/connectors/google/disconnect (body: { provider: 'google_drive' })
  → soft-disable just the google_drive row
  → Gmail / Calendar / etc. unaffected
  → Google access_token remains valid (other rows still use it)
```

### Why per-service rows for a shared token

Three reasons:
1. **Independent sync schedules** per service (Gmail every 1h, Drive every 6h)
2. **Independent disconnect** — user wants Drive off but Gmail on
3. **Per-service config** (Gmail: which folders + categories; Drive: which folder root)

The shared encrypted token lives on the gmail row (the "primary"). Other rows reference it implicitly via the same `userId` lookup.

---

## 8. Sync config + filter enforcement

Critical bug fixed in Phase 2 (commit `c3ce151`): Gmail sync config (`exclude_categories`, `date_range`, `folders`) was logged but never enforced at fetch time. Now translated to Gmail API `q=` syntax in `GmailAdapter._buildGmailQuery`:

| Config | Translated to |
|--------|---------------|
| `date_range: '7d'` | `after:2026/05/10` |
| `folders: ['SENT']` | `labelIds=SENT` + `in:sent` |
| `exclude_categories: ['promotions', 'social']` | `-category:promotions -category:social` |
| `include_only_sent: true` | `in:sent` |
| `exclude_chats: true` (default) | `-in:chats` |
| `include_keywords: ['urgent']` | `urgent` |
| `exclude_keywords: ['unsubscribe']` | `-unsubscribe` |

### Preview-then-approve flow

`POST /api/connectors/gmail/preview` runs the fetch WITHOUT writing to memory. Returns N latest threads matching the config. User selects which threads to actually ingest, then `POST /api/connectors/gmail/ingest-selected { thread_ids: [...] }` persists only the approved ones.

FE: Gmail Sync Settings modal has Preview & Approve / Sync All / Flush all Gmail memories actions.

---

## 9. Memory shape per Google service

All Google sources go through HIVEMIND's memory pipeline. Per-service enrichment:

### Gmail thread / message
```js
{
  memory_type: 'event',  // Prisma enum constraint — see Section 11
  source_metadata: { source_type: 'gmail', source_platform: 'gmail', source_id: 'gmail:thread:<id>' },
  metadata: { type: 'gmail_thread', gmail_thread_id, from, to, labels, message_count, attachment_count, ... },
  tags: [
    'gmail', 'gmail_thread',
    'from:<email>', 'to:<email>', 'participant:<email>',
    'subject:<slug>',
    'label:<gmail-label>',
    'yyyy-mm:2026-05', 'year:2026',
    'newsletter' | 'sent-by-user' | 'has-attachments',
  ],
  document_date: <email Date header>,
}
```

### Drive (doc / sheet / slide / pdf / file)
```js
{
  memory_type: 'fact',
  source_metadata: { source_type: 'google_drive', source_platform: 'google_drive', source_id: 'drive:<file_id>', source_url: '<webViewLink>' },
  metadata: {
    type: 'google_document',  // or sheet/slide/file
    drive_type: 'document',
    drive_file_id, mime_type, file_name, owners, last_modifying_user,
    parents, size_bytes, modified_time, created_time, starred, shared,
    total_chunks, doc_hash,
  },
  tags: [
    'google-drive', 'drive-document', 'document-summary',
    'owner:<email>', 'mime:<mime>', 'drive_type:document',
    'yyyy-mm:2026-05', 'year:2026',
    'file:<filename-slug>',
    'shared' | 'starred',
  ],
}
```

Plus N chunk rows per doc (chunked by `chunkText` at 800-token target).

### Calendar event
```js
{
  memory_type: 'event',
  source_metadata: { source_type: 'google_calendar', source_platform: 'google_calendar', source_id: 'calendar:<event_id>', source_url: '<htmlLink>' },
  metadata: { type: 'calendar_event', calendar_event_id, summary, start, end, location, attendees, organizer, status, recurring, ... },
  tags: [
    'google_calendar', 'calendar_event',
    'with:<email>', 'attendee:<email>', 'organizer:<email>',
    'yyyy-mm:2026-05', 'year:2026',
    'event:<slug>',
    'has-location' | 'recurring' | 'has-attachments' | 'has-video-call',
  ],
  document_date: <event start time>,
  event_dates: [start, end],
}
```

### Contacts
Routes to a separate structured `contacts` table — NOT to memories. No memory pollution.

```js
// In contacts-adapter.js:
normalize() { return []; }  // explicit no-op
extractStructured(contact) { /* upserts into contacts table */ }
```

---

## 10. Operational FAQ

### Q: Sidecar returns 401 on every call
Token expired and refresh failed. Check:
```bash
docker logs hm-core 2>&1 | grep -i 'workspace-mcp\|google.*refresh'
```
If `invalid_grant` → user must reconnect (refresh token revoked Google-side).

### Q: Gmail sync ingests too many emails / promo / spam
Two layers:
1. **Fetch-time filter** (`_buildGmailQuery`) — make sure config has `exclude_categories: ['promotions', 'social', 'updates', 'forums']`
2. **Preview-first flow** — switch the FE Sync Settings modal to "Preview & Approve" instead of "Sync All"

Nuclear: `POST /api/connectors/gmail/flush?hard=true` purges all Gmail memories (Postgres + Qdrant), then re-sync with strict config.

### Q: One user disconnected Drive but Gmail also stopped working
Check `platform_integrations` rows:
```sql
SELECT provider, is_active, last_synced_at, scopes
FROM platform_integrations
WHERE user_id = '<uuid>';
```
If `gmail.is_active=false` → that's the bug. Re-run `/api/connectors/gmail/connect`.

### Q: Drive doc body is empty
Sidecar's `get_drive_file` returned no text. Possible causes:
- PDF without OCR text layer → returns nothing usable
- Google Doc with images-only content
- Permissions: token user can't read this file (shared restricted)

Check sidecar logs:
```bash
docker logs workspace-mcp 2>&1 | grep -i 'get_drive_file'
```

### Q: Calendar events show wrong timezone
Sidecar returns ISO 8601 strings. HIVEMIND stores `document_date` as the start time. FE renders in user's browser timezone. If wrong, check `event.start.dateTime` in raw response — should be RFC3339 with offset.

### Q: `live-query-router` matches non-Google terms (e.g. asks "what's the weather")
Router's intent regex is conservative. Check `core/src/connectors/providers/google/live-query-router.js` → `QUERY_INTENT_PATTERNS`. False positives should match a Google-specific keyword (calendar, event, drive, file, doc, email, etc.) before triggering a live call.

### Q: New connection grants Drive even though user only checked Gmail
Bug fixed in `33342dd`. Verify the running build has the fix:
```bash
ssh myserver "cd /opt/HIVEMIND && git log --oneline core/src/connectors/providers/gmail/oauth.js | head -3"
```
Should show commit `33342dd` (`fix(gmail-oauth): only persist services user actually requested`) or later.

---

## 11. Roadmap

### Phase 2.5: Drive / Calendar preview flow
Mirror the Gmail preview-then-approve UX for Drive (file picker → preview table → selective ingest) and Calendar (date-range preview → selective ingest). Backend endpoints exist in concept; FE modals not yet built.

### Phase 3: Per-provider memory_type enum
Currently capped to Prisma `MemoryType` enum (`fact / preference / decision / lesson / goal / event / relationship`). Per-provider types live in `metadata.type` as a workaround. Migration to extend the enum with `gmail_thread`, `drive_document`, `calendar_event`, etc. is gated on:
- All downstream consumers (recall ranker, FE type badges, prisma store, audit log filters) audited for the new values
- Schema migration written + tested up + down

### Phase 4: Expose Google tools as MCP tools to AI agents
Currently the workspace-mcp tools are HIVEMIND-internal. Eventually expose them via HIVEMIND's own `/api/mcp` so Claude / Cursor / etc. can:
- "Send an email to alice@ saying X"
- "Schedule a meeting with bob@ next Tuesday at 3pm"
- "Pull the Q4 budget spreadsheet"

Gating: per-tool policy enforcement (no autonomous email send without user approval modal — same pattern as Talk-to-HIVE slack-action approval).

### Phase 5: Pre-ingest pollution gate
Currently fetch-time filtering (Gmail `q=`) catches most noise. Add a SECOND gate at the memory ingest step: connectors call `policy-engine.shouldIngest(payload)` BEFORE persisting. Noisy senders / low-info threads get rate-limited or rejected outright.

### Phase 6: Self-hosted workspace-mcp build
Currently using upstream `taylorwilsdon/google_workspace_mcp` image. Plan: fork + pin a HIVEMIND-tuned version with:
- Slimmer tool surface (only the 30 we actually call)
- Built-in stateless-mode enforcement
- Per-tenant rate-limit guards
- Better error messages

---

## 12. File index

```
core/src/connectors/
├── gmail.connector.js                          # Legacy entry, mostly wraps providers/gmail/
├── providers/
│   ├── gmail/
│   │   ├── adapter.js                          # Gmail-specific fetch + normalize (native API, NOT via bridge)
│   │   ├── oauth.js                            # OAuth flow (services=… param controls scope set)
│   │   ├── email-cleaner.js                    # HTML→Markdown, strip trackers, zero-width chars
│   │   ├── contacts-store.js                   # Per-contact structured upsert
│   │   └── gmail-watch.js                      # Pub/Sub push notifications
│   └── google/
│       ├── workspace-mcp-bridge.js             # Bridge class (callTool, getAccessToken, listTools)
│       ├── drive-docs-adapter.js               # Drive Docs/Sheets/Slides ingestion (via bridge)
│       ├── calendar-adapter.js                 # Calendar event ingestion (via bridge)
│       ├── contacts-adapter.js                 # Contacts → structured table (NOT memory)
│       └── live-query-router.js                # Talk-to-HIVE → bridge.callTool() on detected intent
├── framework/
│   ├── provider-adapter.js                     # Base class for all adapters
│   ├── connector-store.js                      # Prisma wrapper for platform_integrations
│   └── sync-scheduler.js                       # Cron-driven per-tenant sync runner
└── server.js endpoints:
    /api/connectors/gmail/connect               # Build Google OAuth URL
    /api/connectors/gmail/callback              # Exchange code → encrypted token
    /api/connectors/gmail/sync                  # Trigger sync (bypass preview)
    /api/connectors/gmail/preview               # Dry-run fetch w/ config applied (no DB writes)
    /api/connectors/gmail/ingest-selected       # Persist approved thread_ids only
    /api/connectors/gmail/flush                 # Soft-delete all Gmail memories
    /api/connectors/gmail/flush?hard=true       # Hard-delete (Postgres + Qdrant)
    /api/connectors/gmail/disconnect            # Revoke gmail row
    /api/connectors/google/sync                 # Per-service sync (non-gmail)
    /api/connectors/google/status               # Per-service status map
    /api/connectors/google/disconnect           # Per-service disconnect

frontend/Da-vinci/src/components/hivemind/app/pages/
├── Connectors.jsx                              # Connect / disconnect / sync settings
└── (no dedicated Workspace page — managed inside Connectors)
```

---

## 13. Env switches

| Var | Default | Effect |
|-----|---------|--------|
| `WORKSPACE_MCP_URL` | `http://workspace-mcp:8000` | Sidecar endpoint |
| `WORKSPACE_MCP_STATELESS_MODE` | `true` | Force per-call auth (sidecar refuses to cache) |
| `WORKSPACE_MCP_EXTERNAL_OAUTH21_PROVIDER` | `true` | Tells sidecar HIVEMIND owns OAuth |
| `GOOGLE_CLIENT_ID` | — | OAuth client (set in Coolify env) |
| `GOOGLE_CLIENT_SECRET` | — | OAuth secret |
| `HIVEMIND_BASE_URL` | derived | Used for OAuth redirect URI construction |
| `HIVEMIND_TOKEN_ENCRYPTION_KEY` | — | 32-byte hex for AES-256-GCM token at-rest encryption |
| `GCP_PUBSUB_TOPIC` | optional | Enable Gmail Pub/Sub push (history-id-based incremental) |

---

## 14. Hardening posture

| Concern | Mitigation |
|---------|-----------|
| Token theft from disk | AES-256-GCM at rest; key in env (Coolify secrets) |
| Token leak via logs | `decryptToken` output never logged; only key prefix shown |
| Cross-tenant token access | Bridge resolves token via `userId` parameter; no global cache |
| Sidecar caches tokens | `WORKSPACE_MCP_STATELESS_MODE=true` enforces no caching |
| Stale token used | Auto-refresh < 5 min before expiry inside `getAccessToken` |
| Scope leak across services | OAuth flow filters granted-scopes intersection with state.services (fix `33342dd`) |
| Promo / spam pollution | Fetch-time `q=` filter + preview-approve modal + LLM verifier in Governance Swarm |
| Mass ingest race | Per-tenant concurrency gate on `/api/connectors/gmail/sync`; max 1 sync per user at a time |
| Hard delete safety | `POST /api/connectors/gmail/flush?hard=true` deletes Postgres + Qdrant + cascades audit_log refs; SOFT default |

---

## 15. References

- Upstream workspace-mcp: https://github.com/taylorwilsdon/google_workspace_mcp
- HIVEMIND MCP architecture: `core/docs/MCP_SERVER.md`
- Governance Swarm: `core/docs/GOVERNANCE_SWARM.md`
- Memory engine upgrades: `core/docs/memory_engine_upgrade.md`
- Phase 2 per-provider ingestion plan: `docs/architecture/per-provider-ingestion-v2.md`

Last lock-in: 2026-05-17.
