# HIVEMIND Connectors — Knowledge Ingestion from External Apps

> This folder is the single source of truth for **how a connected app's data
> becomes HIVEMIND memory**: auth → config/filters → sync (manual, scheduled,
> realtime) → normalize → persist → embed → recall. One file per connector
> family. Every claim below is anchored to an exact `file:line` so you can
> jump straight to the code.
>
> Start here for the shared architecture, then read the per-connector doc.
> First connector documented: **[EMAIL.md](./EMAIL.md)** (Gmail / Google
> Workspace).

Related cross-cutting docs: [`../NANGO.md`](../NANGO.md) (OAuth control
plane), [`../SLACK.md`](../SLACK.md) (Slack connector + bot),
[`../INGESTION_PIPELINE_README.md`](../INGESTION_PIPELINE_README.md),
[`../KNOWLEDGE_BASE_INGESTION.md`](../KNOWLEDGE_BASE_INGESTION.md).

---

## 1. The two auth models (know which one your connector uses)

HIVEMIND has **two parallel OAuth paths**. Picking the wrong one is the #1
source of connector bugs.

| Model | Used by | Token storage | Auth entry |
|---|---|---|---|
| **Native OAuth** | Gmail / Google Workspace, Slack | `PlatformIntegration` row, AES-256-GCM (`connector-store.js`) | provider `oauth.js` `buildAuthUrl` → provider `/callback` in `core/src/server.js` |
| **Nango** | Notion, GitHub, Linear, Jira/Confluence, Salesforce, Gemini | Nango vault + `hivemind.nango_connections` ownership row | `POST /api/connectors/connect-session` → Nango Connect UI popup |

- **Native** is used where we need tokens/scopes Nango's template can't give
  (Gmail needs `gmail.readonly` + Pub/Sub; Slack needs both bot AND user
  tokens). The token lives only in `PlatformIntegration.accessTokenEncrypted`.
- **Nango** is the default for everything else — see `../NANGO.md`.

> Gmail is **native** despite "Nango-style" naming in places. There is **no
> Nango connection for gmail**; `getConnectionId` returning null for gmail is
> expected, not a bug. The Gmail sync path reads its token from
> `ConnectorStore.getAccessToken`, never from Nango.

## 2. Storage: the `PlatformIntegration` row

Every native connector is one row keyed by `(userId, platformType)`
(`core/src/connectors/framework/connector-store.js`).

| Column | Holds |
|---|---|
| `platformType` | provider id (`gmail`, `slack`, `google-drive`, …) |
| `accessTokenEncrypted` / `refreshTokenEncrypted` | AES-256-GCM tokens (`encryptToken`/`decryptToken`) |
| `tokenExpiresAt` | refresh trigger |
| `targetScope` | `'personal'` \| `'organization'` — drives which memory scope ingested rows land in |
| `syncStatus` | `idle` \| `syncing` \| `error` \| `revoked` \| `reauth_required` |
| `syncIntervalMinutes` | per-connector auto-sync cadence (null → global default) |
| `lastSyncedAt` / `lastSchedulerRunAt` | telemetry / due-time math |
| `connectorMetadata` (JSON) | `{ cursor, sync_stats, sync_config, watch, provider_metadata, … }` |

**`connectorMetadata.sync_config`** is the heart of filtering: the user's
ingestion preferences (date range, folders, category/keyword/sender excludes)
persisted here so that **scheduled auto-syncs replay the exact same filters
the user picked in the UI** — not a firehose.

## 3. The sync architecture (provider-agnostic)

```
                 ┌─────────────────── triggers ───────────────────┐
   manual run    scheduled tick (1 min)        realtime push (provider webhook)
   POST /sync    sync-scheduler.js             e.g. Gmail Pub/Sub
        │              │                              │
        └──────────────┴──────────────┬───────────────┘
                                       ▼
                         sync-engine.js  runSync()
                          fetch → normalize → dedupe → ingest
                                       │
   adapter.fetchInitial/fetchIncremental (provider API, applies FILTERS here)
                                       │
   adapter.toMemoryPayloads()  → [{ content, title, tags, memory_type,
                                     document_date, source_metadata, metadata }]
                                       │
   sync-engine._ingestWithRetry → persistentMemoryEngine.ingest (Postgres row)
                                       │
   sync-engine._postIngestHooks → external_ref (dedupe) + entity linking +
                                   Qdrant embed/upsert (vector recall)
                                       ▼
                              HIVEMIND memory + graph + vector
```

Key files (all under `core/src/connectors/framework/`):

| File | Role |
|---|---|
| `sync-engine.js` | The orchestrator. `runSync()` = fetch loop → payloads → ingest → post-hooks. Owns cursor persistence, 401→refresh, retry/backoff, status flips. |
| `sync-scheduler.js` | Ticks every 60 s; runs `runSync` for every connector whose `syncIntervalMinutes` (or global default) has elapsed. Replays persisted `sync_config`. |
| `connector-store.js` | The `PlatformIntegration` CRUD + token crypto + `getAccessToken` (native-first, Nango fallback). |
| `webhook-processor.js` | Inbound realtime push handling. |
| `provider-adapter.js` / `base-connector-adapter.js` | The adapter contract every provider implements. |
| `adapter-registry.js` | Maps `platformType` → adapter module. |

Each provider lives in `core/src/connectors/providers/<name>/` and implements
the adapter contract (`fetchInitial`, `fetchIncremental`, `toMemoryPayloads`,
`dedupeKey`, optional `extractStructured`).

## 4. Three sync modes (every connector should aim for all three)

1. **Manual** — user clicks Sync in the Connectors modal → `POST
   /api/connectors/<provider>/sync` (or `/gmail/sync`). Persists `sync_config`,
   runs in the background, returns a sync id immediately.
2. **Scheduled (auto)** — `sync-scheduler` tick. Cadence set per-connector via
   `POST /api/connectors/cadence { provider, sync_interval_minutes }` (15-min
   floor, null = global default). Replays the persisted `sync_config`.
3. **Realtime push** — provider webhook (Gmail Pub/Sub `users.watch`, Slack
   Events API). Lowest latency; the provider notifies us of changes and we
   incrementally fetch.

## 5. The noise floor (why your memory isn't full of spam)

Ingestion quality is enforced in **layers**, cheapest first — kill noise as
early as possible so it never costs storage / embedding / recall pollution:

1. **Provider-query filter** (cheapest) — the fetch query itself excludes
   junk so it never leaves the provider. Gmail: `_buildGmailQuery` builds a
   `q=` with `-category:promotions`, `after:`, `-from:<blocklist>`, etc.
2. **Per-message noise classifier** — `email-cleaner.js classifyNoise` drops
   auto-replies, OOO, bounces, platform/CI notifications, bulk-list mail,
   empty bodies.
3. **ACL / scope gate** — purely-personal outgoing mail is skipped in
   org/team scope (no org-wide exposure of private threads).
4. **Content cleaning** — quote-trimming, signature/tracking-pixel removal
   before the text is stored or embedded.
5. **Dedupe** — `source_metadata.source_id` + `external_ref` make re-sync
   idempotent (the same email never becomes two memories).

> **SENT mail always passes** every filter — the user's own outbound is
> ground truth and the single biggest recall-quality boost.

## 6. How an ingested record becomes a memory

`adapter.toMemoryPayloads()` returns objects shaped for
`persistentMemoryEngine.ingest`:

- `content` — the cleaned text the model reads + embeds.
- `title` — subject / record name (also embedded — carries entity signal).
- `tags` — rich, queryable facets: `entity:<Name>`, `person:<x>`,
  `from:<addr>`, `subject:<…>`, `label:<…>`, `YYYY-MM` for time facets.
- `memory_type` — `'event'` for messages (temporal, decay-aware, no fact
  extraction) vs `'fact'`-shaped for structured records.
- `document_date` / `event_dates` — **when it happened** (the email Date
  header), not when ingested — critical for "emails from last week".
- `source_metadata` — `{ source_type, source_platform, source_id, thread_id,
  … }`; `source_id` is the dedupe key.
- `metadata.force_entity_linking: true` — forces the canonical entity-linker
  (Updates/Extends/Mentions edges) to fire even on short messages.

Then `sync-engine._postIngestHooks` embeds an **augmented key**
(`title + entity tags + content`) into Qdrant (`HIVEMIND_PERSONAL` or the
per-org collection) — not raw content alone, because connector records are
often terse/schema-shaped and the entity signal lives in title + tags.

## 7. Adding a new connector — checklist

1. `core/src/connectors/providers/<name>/` with `oauth.js` (native) **or** a
   Nango integration registration (`../NANGO.md` §3), plus `adapter.js`.
2. Implement the adapter contract; build the provider-query **filter** in the
   adapter (noise floor layer 1).
3. Register in `adapter-registry.js` and the catalog (`catalog.js`).
4. Add the auth route (native `/callback` in `server.js`, or reuse the Nango
   connect-session endpoint).
5. Add `/api/connectors/<name>/sync` (manual) — persist `sync_config`.
6. Confirm `sync-scheduler` picks it up (it iterates all non-revoked rows).
7. Add realtime push if the provider supports it.
8. Wire the FE: `api-client.js` methods + a Connectors-page card + filter
   modal that writes `sync_config`.
9. **Write its doc in this folder.**

---

Per-connector docs:
- **[EMAIL.md](./EMAIL.md)** — Gmail / Google Workspace (native OAuth, Pub/Sub
  realtime, the full filter + noise-floor reference).
