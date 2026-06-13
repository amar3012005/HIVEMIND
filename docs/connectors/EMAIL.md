# EMAIL Connector — Gmail / Google Workspace Ingestion

> The complete, line-anchored map of how a user's Gmail becomes HIVEMIND
> memory: **auth (native OAuth, not Nango) → config & filters → manual sync →
> scheduled auto-sync → realtime Pub/Sub push → normalize → persist → embed**.
>
> Verified against the codebase 2026-06-13. Read [`README.md`](./README.md)
> first for the shared connector architecture.
>
> **TL;DR pipeline:**
> `gmail/connect` → Google consent → `gmail/callback` (token → `PlatformIntegration`)
> → `gmail/sync` (manual, persists `sync_config`) **and** `sync-scheduler`
> (auto, replays `sync_config`) **and** Pub/Sub `users.watch` (realtime)
> → `GmailAdapter` (fetch + filter) → `toMemoryPayloads` → `sync-engine`
> ingest → memory + Qdrant.

---

## 0. File map (jump table)

| Concern | File | Key symbols |
|---|---|---|
| OAuth config / scopes / code exchange | `core/src/connectors/providers/gmail/oauth.js` | `getOAuthConfig` :29, `buildAuthUrl` :57, `exchangeCode` :80 |
| Start auth | `core/src/server.js` | `case '/api/connectors/gmail/connect'` :9816 |
| **Auth persist (after Google)** | `core/src/server.js` | `'/api/connectors/gmail/callback'` :6053 |
| Token storage + crypto | `core/src/connectors/framework/connector-store.js` | `upsertConnector` :94, `getAccessToken`, `updateMetadata` :311 |
| **Manual sync + filters** | `core/src/server.js` | `case '/api/connectors/gmail/sync'` :10899 |
| Fetch + per-message filtering | `core/src/connectors/providers/gmail/adapter.js` | `GmailAdapter` :15, `fetchInitial` :34, `fetchIncremental` :111, `_buildGmailQuery` :550, `_buildRichTags` :658 |
| Noise classifier | `core/src/connectors/providers/gmail/email-cleaner.js` | `classifyNoise` :218, called from adapter :218 (`cleanResult.noise?.skip`) |
| Record → memory payload | `core/src/connectors/providers/gmail/adapter.js` | single-message payload built :322–:363, thread-parent :423, thread-child :465, `return payloads` :492 |
| **Sync orchestration** | `core/src/connectors/framework/sync-engine.js` | `runSync` :47, `_ingestWithRetry` def :299 (call :252), `_postIngestHooks` :370, reauth flip :86/:135, final-cursor write :143/:279 |
| **Auto-sync scheduler** | `core/src/connectors/framework/sync-scheduler.js` | `_tick` :71, cadence math |
| Cadence API | `core/src/server.js` | `case '/api/connectors/cadence'` :11357 |
| **Realtime push** | `core/src/connectors/providers/gmail/gmail-watch.js` | `registerWatch` :30, `renewAllWatches` |
| Pub/Sub webhook | `core/src/server.js` | `'/api/connectors/gmail/pubsub-webhook'` :11582 |
| Normalizer | `core/src/memory/normalizers/gmail.js` | — |
| FE client | `frontend/Da-vinci/src/components/hivemind/app/shared/api-client.js` | `gmailConnect` :1332, `gmailSync` :1345, cadence :1357, `gmailPreview` :1385 |
| Control-plane proxy | — | `/v1/proxy/connectors/gmail/*` → core `/api/connectors/gmail/*` |

---

## 1. Auth — native OAuth, where the connection is bound

**Gmail does NOT use Nango.** It runs its own Google OAuth2 and stores the
token in `PlatformIntegration`. The control plane proxies the browser to core.

### 1a. Start (`/api/connectors/gmail/connect`, server.js:9816)
- FE calls `apiClient.gmailConnect(targetScope, services)`
  (api-client.js:1332) → control-plane `/v1/proxy/connectors/gmail/connect`.
- Core builds the redirect URI
  `${HIVEMIND_BASE_URL}/api/connectors/gmail/callback` (server.js:9819) and
  calls `buildAuthUrl` (oauth.js:57) with a signed `state`
  (`userId`, `orgId`, `targetScope`, requested `services`).
- Scopes come from `getOAuthConfig` (oauth.js:29): **read-only** per-service
  scopes (`gmail.readonly`, optional `drive/calendar/docs/...readonly`). No
  write-back. `include_granted_scopes` is deliberately omitted (oauth.js:67)
  so a partial grant doesn't silently widen access.

### 1b. ⭐ The bind point (`/api/connectors/gmail/callback`, server.js:6053)
**This is the exact place auth completes and the connection is persisted.**

1. Verify `state` (`verifyOAuthState`, server.js:6069) — refuse to bind on
   mismatch (CSRF guard).
2. `exchangeCode({ code, redirectUri })` (oauth.js:80) → access + refresh
   tokens + the user's Google email.
3. Plan-limit check (`planEnforcer.checkLimit(orgId, 'connectors')`,
   server.js:6090).
4. Map **granted** scopes → canonical service ids
   (`SCOPE_TO_SERVICE`, server.js:6099) and intersect with what was
   **requested** — so connecting "Gmail + Drive" creates exactly those rows,
   nothing wider.
5. For each granted service: `connStore.upsertConnector({...})`
   (server.js:6143) writes one `PlatformIntegration` row per service with the
   **encrypted** access + refresh tokens, `tokenExpiresAt`, `targetScope`,
   `scopes`, and `metadata.email`.

After this, the connection is live; `connector-store.getAccessToken(userId,
'gmail')` returns a fresh decrypted token (auto-refreshing via the refresh
token when `tokenExpiresAt` has passed).

> Multi-service note: one Google consent can bind `gmail`, `google-drive`,
> `google-calendar`, `google-docs`, … as **separate** `PlatformIntegration`
> rows sharing one Google account. See `SCOPE_TO_SERVICE`/`SHORT_TO_CANON`
> (server.js:6099–6128).

---

## 2. Configuration & filters — the noise floor

Filtering is applied in layers (see README §5). For Gmail the layers are:

### Layer 1 — Gmail `q=` query (cheapest; junk never leaves Google)
Built two places that **mirror each other**:
- `GmailAdapter._buildGmailQuery(config)` (adapter.js:550) — used by the
  scheduler/engine path.
- inline in `/api/connectors/gmail/sync` (server.js:10925+) — used by manual
  sync.

Honored `sync_config` keys → Gmail query:

| `sync_config` key | Gmail `q=` fragment | Meaning |
|---|---|---|
| `date_range` (`7d`/`30d`/`90d`/`365d`/`all`) | `after:YYYY/MM/DD` | only recent mail |
| `folders` (label ids, default `['INBOX','SENT']`) | `in:<label>` / `labelIds=` | which mailboxes |
| `exclude_categories` (`promotions`/`social`/`updates`/`forums`) | `-category:<c>` | drop Gmail tab noise |
| `include_keywords` | `kw` / `"phrase"` (AND) | must-match |
| `exclude_keywords` | `-kw` / `-"phrase"` (NOT) | must-not-match |
| `include_only_sent` | `in:sent` | sent-only mode |
| `exclude_chats` (default true) | `-in:chats` | drop Google Chat |
| `block_senders` + `DEFAULT_BLOCK_SENDERS` | `-from:<addr/domain>` | sender blocklist |

**`DEFAULT_BLOCK_SENDERS`** (adapter.js:612, mirrored server.js:10947) is a
built-in newsletter/notification blocklist applied to every sync unless
`disable_default_blocklist: true`: `noreply@*`, `*@substack.com`,
`*@notifications.*`, `*@mailer.*`, `*@newsletter.*`, `*@calendar.google.com`,
`*@bounces.*`, etc. Wildcard `*@domain` → `-from:domain`. These threads never
enter Postgres, never embed, never index.

### Layer 2 — per-message noise classifier (`email-cleaner.js classifyNoise` :218)
Anything that slips through `q=` is re-checked per message and dropped if:

| Reason (`email-cleaner.js`) | Line | Drops |
|---|---|---|
| `auto-submitted: …` | :222 | `Auto-Submitted` header set |
| `auto-reply header` | :227 | `X-Autoreply`/`X-Autorespond` |
| `out-of-office` | :232 | MS OOO classification |
| `bounce/delivery-failure` | :241 | mailer-daemon / undelivered |
| `platform-notification` | :253 | GitHub/CI/Vercel/Sentry/… `[repo] Run failed…` |
| `bulk-list-notification` | :262 | `Precedence: bulk` + `List-Id` + noreply |
| `empty-body` | :273 | < 20 chars |
| `calendar-invite` (kept, flagged) | :268 | `.ics` → minimal event memory |
| `newsletter` (kept, flagged) | :278 | unsubscribe-only body |

The adapter consults this at adapter.js:218 — `if (cleanResult.noise?.skip)`
→ skip + log the reason (`[gmail-adapter] Skipping message <id>: <reason>`).

> The `platform-notification` + `bulk-list-notification` rules were added
> 2026-06-12 after a failing-CI week fanned **157 "Run failed" emails** into
> one user's memories. See [`../NANGO.md`] / session history.

### Layer 3 — ACL / scope gate (adapter.js:225–:232)
`sentByUser` is determined at :225 (`fromEmail === userEmail`). In org/team
`targetScope` the org-scope skip fires at :232 — purely-personal outgoing
mail (every message sent by the installer to a non-shared address) is dropped
to avoid org-wide exposure of private threads. Shared-mailbox traffic always
passes.

### The override: SENT mail always passes
- `sentByUser` bypasses the newsletter-only gate (:250) and the
  short-body gate (:259).
- Attribution stamp `'first_person'` set at :244.
- `sent_by_user: true` propagated into payload metadata at :344 — read by
  `persisted-retrieval` for the +25 % recall boost.
The user's own outbound is ground truth and the biggest recall lever, so it
bypasses the personal-skip heuristics.

### Where `sync_config` is persisted
`/api/connectors/gmail/sync` writes it via `syncStore.updateMetadata(userId,
'gmail', { sync_config: {...} })` (server.js:~10978; persist code path
defined in `connector-store.updateMetadata` :314) into
`connectorMetadata.sync_config`. **This is the contract that makes auto-sync
honor the user's modal choices** instead of running the firehose — the
scheduler reads it back on every tick.

---

## 3. Manual sync (`/api/connectors/gmail/sync`, server.js:10899)

1. Body accepts `date_range`, `folders`, `exclude_categories`, `max_emails`
   (default 500, cap), `block_senders`, `disable_default_blocklist`,
   `container_tag`, `target_scope`, and `auto_sync_minutes` (set cadence in
   the same round-trip, server.js:10993).
2. Loads the connector (`syncStore.getConnector`), resolves `targetScope`.
3. Builds the Gmail `q=` (server.js:10925+, mirrors `_buildGmailQuery`).
4. **Persists `sync_config`** (server.js:~10978) so auto-sync replays it.
5. Flips status to `syncing`, returns a `syncId` immediately
   (server.js:11025), runs the fetch in the background (server.js:11028):
   - `getAccessToken(userId,'gmail')` (decrypt + auto-refresh).
   - Pages `GET /gmail/v1/users/me/threads?q=<query>&maxResults=…`
     (server.js:11034), fetches each thread `?format=full`, ingests
     thread-level, respects `max_emails`, tracks `totalImported/Skipped`.

FE: `apiClient.gmailSync(settings)` (api-client.js:1345). Dry-run preview:
`gmailPreview` (:1385) → `/api/connectors/gmail/preview` (server.js:10428).

---

## 4. Scheduled auto-sync (`sync-scheduler.js`)

- Ticks every **60 s** (`TICK_INTERVAL_MS`, sync-scheduler.js:18); `_tick`
  (:71) selects connectors whose due-time has elapsed.
- Per-connector cadence = `syncIntervalMinutes` (15-min floor) or the global
  default (`HIVEMIND_SYNC_INTERVAL_MS`, default 60 min). Due = `now -
  lastSchedulerRunAt ≥ cadence`.
- For each due connector it resolves the adapter (`adapter-registry`), then
  calls `syncEngine.runSync({ adapter, userId, orgId, provider, incremental,
  targetScope, … })` (sync-scheduler.js:193).
- The adapter's `_buildGmailQuery` reads the persisted
  `connectorMetadata.sync_config` → **same filters as the manual run**.
- Stamps `lastSchedulerRunAt` on success (sync-scheduler.js:210) AND on
  failure (:226) so a broken connector isn't retried every minute.

### Cadence API (`/api/connectors/cadence`, server.js:11357)
- `GET` → per-connector cadences (`syncIntervalMinutes`,
  `effective_interval_minutes`, `last_synced_at`, `status`).
- `POST { provider, sync_interval_minutes }` → set/clear cadence
  (null = global default; 15 ≤ n ≤ 43200). FE: api-client.js:1357.

---

## 5. Realtime push — Gmail Pub/Sub (`gmail-watch.js`)

Lowest-latency path; Google notifies us of mailbox changes.

1. `registerWatch({ accessToken, topicName, labelIds })` (gmail-watch.js:30)
   calls Gmail `users.watch` → Google publishes change events to our Pub/Sub
   topic (`GCP_PUBSUB_TOPIC`). Stores `expiration` + `historyId` in
   `connectorMetadata.watch`.
2. Pub/Sub push → `/api/connectors/gmail/pubsub-webhook` (server.js:11582)
   with the user's `emailAddress` + new `historyId`.
3. We resolve the user, then incrementally fetch via the Gmail **history
   API** (`adapter.fetchIncremental`, adapter.js:111) from the stored cursor;
   if the `historyId` is too old, fall back to full sync (adapter.js:126).
4. `renewAllWatches()` (gmail-watch.js) runs daily — watches expire after
   7 days (`RENEW_BEFORE_MS` = 1-day margin, gmail-watch.js:23).

Setup commands: [`../gmail-pubsub-setup.md`](../gmail-pubsub-setup.md).

---

## 6. Fetch → normalize → memory (the ingest core)

### 6a. Adapter produces payloads
`fetchInitial`/`fetchIncremental` (adapter.js:34/:111) return raw threads
(filters already applied at `q=` time). For each surviving message
`toMemoryPayloads` builds (shape at adapter.js:~309):

```js
{
  user_id, org_id, project: null,
  content,                       // cleaned thread/message text
  title,                         // subject (or "Re: subject")
  tags: [ entity:<Name>, person:<x>, from:<addr>, subject:<…>,
          label:<…>, 'gmail-thread', 'YYYY-MM' ],
  memory_type: 'event',          // temporal, decay-aware, no fact extraction
  skipProcessing: true,
  document_date,                 // email Date header (when it happened)
  event_dates: [date],
  source_metadata: { source_type:'gmail', source_platform:'gmail',
                     source_id: msg.id, thread_id, parent_message_id },
  metadata: { gmail_thread_id, gmail_message_id, from, to, labels,
              message_index, thread_length, content_attribution,
              sent_by_user, attachments, force_entity_linking: true },
  relationship: { type:'Extends', related_to:null }  // replies extend original
}
```

### 6b. Sync-engine persists + post-processes (`sync-engine.js runSync` :47)
- Calls the adapter fetch loop; on 401 attempts a token refresh, flips to
  `reauth_required` if the token is truly dead (sync-engine.js:86 initial
  bearer-fetch path, :135 mid-loop refresh path).
- Payloads from the adapter → for each `_ingestWithRetry(payload, sourceId,
  userId)` (call at sync-engine.js:252, definition :299) →
  `persistentMemoryEngine.ingest` writes the Postgres memory row. `sourceId`
  (= `source_metadata.source_id`) makes re-sync **idempotent** — the same
  email never doubles.
- `_postIngestHooks` (sync-engine.js:370, fires after every ingest):
  - writes `external_ref` for re-sync dedupe,
  - runs the **canonical entity-resolver** (Updates/Extends/Mentions edges) —
    forced on by `metadata.force_entity_linking`,
  - **embeds + upserts to Qdrant**: an *augmented key*
    `title + entity tags + content` (not raw content), into
    `HIVEMIND_PERSONAL` (or the per-org collection). Without this hook,
    connector memories would be FTS-only and invisible to vector recall.
- On completion flips status to `idle` and persists the `final_cursor`
  (sync-engine.js:143 mid-loop update, :279 final commit) for the next
  incremental run.

### 6c. Result in HIVEMIND
The email is now: a Postgres memory row (`memory_type:'event'`,
`document_date` = sent time), graph edges to the people/entities it mentions,
and a Qdrant vector — recallable by content, by sender/subject/label facet
tags, and by time ("emails from last week").

---

## 7. Other Gmail endpoints (server.js)

| Endpoint | Line | Purpose |
|---|---|---|
| `/api/connectors/gmail/status` | :10372 | connection + last sync state |
| `/api/connectors/gmail/disconnect` | :10395 | remove the connector |
| `/api/connectors/gmail/flush` | :10741 | hard-delete all Gmail-sourced memories (per-tenant Qdrant + cursor reset) |
| `/api/connectors/gmail/preview` | :10428 | dry-run fetch (no ingest) for the filter modal |
| `/api/connectors/gmail/ingest-selected` | :10530 | ingest only user-picked threads |
| `/api/connectors/gmail/pubsub-webhook` | :11582 | realtime push receiver |

---

## 8. Quick verification (prod)

```bash
# Connection state for a user
SELECT platform_type, sync_status, sync_interval_minutes, last_synced_at,
       connector_metadata->'sync_config' AS filters
FROM hivemind.platform_integrations
WHERE user_id='<uuid>' AND platform_type='gmail';

# Did filters take? Check ingested gmail memories
SELECT count(*) FROM hivemind.memories m
JOIN hivemind.source_metadata s ON s.memory_id=m.id
WHERE m.user_id='<uuid>' AND s.source_platform='gmail' AND m.deleted_at IS NULL;

# Trigger a manual sync (master key)
curl -X POST http://localhost:3000/api/connectors/gmail/sync \
  -H "X-API-Key: $MASTER" -H "X-HM-User-Id: <u>" -H "X-HM-Org-Id: <o>" \
  -d '{"date_range":"30d","folders":["INBOX","SENT"],
       "exclude_categories":["promotions","social"],"auto_sync_minutes":60}'
```

---

## 9. Known gotchas

- **Gmail has no Nango connection** — `getConnectionId` returning null for
  gmail is correct. Token lives in `PlatformIntegration`, fetched via
  `connector-store.getAccessToken`.
- **Manual and scheduled paths build the query twice** (server.js inline vs
  `_buildGmailQuery`). They must stay mirrored — change both or noise
  diverges between the two modes.
- **`sync_config` is the contract.** If auto-sync "ignores the user's
  choices", it's because the manual run didn't persist `sync_config` (or the
  scheduler isn't reading it).
- **Pub/Sub watches expire after 7 days** — `renewAllWatches` must run daily
  or realtime silently stops (scheduled sync still covers it).
- **`force_entity_linking`** is what makes short replies still produce graph
  edges; dropping it degrades relationship recall.
