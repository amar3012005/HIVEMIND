# Per-Provider Ingestion v2 — Approval Flow + Structured Schemas

**Status**: Phase 1 partially shipped. Phase 2 pending.

## Problem (user-reported)

> "Whenever I sync Gmail, it pollutes the whole memory graph. Sync
> configurations (sent-only, no promo) are ignored. The graph and memories
> are full of Gmail noise. Tags are generic and not useful for recall."

Concrete issues:

1. **Sync config bypass** — `exclude_categories`, `folders` filters not
   enforced at fetch time.
2. **No human gate** — every fetched email pushed straight into memory.
3. **Generic memory shape** — emails saved with `memory_type: 'event'` and
   minimal source-specific structure.
4. **Weak tags** — only `['gmail', ...labels]` historically. No
   `from:<email>`, `to:<email>`, `subject:<slug>`, `yyyy-mm:<date>`.
5. **All providers share one ingestion path** — Gmail, Drive, Calendar
   funnel into the same generic memory shape.

## Phase 1 — Shipped

- ✅ `/api/connectors/gmail/flush` — one-shot soft-delete of all Gmail
  memories for current user. UI button (next iteration) calls this for
  cleanup.
- ✅ Rich Gmail tags via `GmailAdapter._buildRichTags`:
  - `from:<email>` (every sender in thread)
  - `to:<email>` (every recipient)
  - `participant:<email>` (union)
  - `subject:<slug>` (60-char normalized slug)
  - `label:<gmail-label>` (namespaced)
  - `yyyy-mm:<YYYY-MM>` + `year:<YYYY>` (time-aware recall)
  - `newsletter` / `sent-by-user` / `has-attachments` (attribution)
- ✅ Memory Graph 2D Sources dropdown — filter by `source_platform` /
  inferred source. Persisted to localStorage. Shows count per source.

## Phase 2 — Design (pending)

### A. Per-provider memory types

Replace generic `memory_type: 'event'` with provider-specific types:

```js
gmail_thread     → email thread (1 memory per thread, structured markdown)
gmail_message    → single message (when thread-mode disabled)
drive_doc        → Google Doc
drive_sheet      → Google Sheet (with structured table extract)
drive_slide      → Google Slide deck
drive_file       → PDF / other
calendar_event   → event with attendees, location, recurrence
contact          → person from Contacts
```

Memory shape per type follows the source's native structure rather than
flattening to plain `content`.

### B. Approval flow (the gate)

New endpoints:

```
POST /api/connectors/gmail/preview
  body: { date_range, folders, exclude_categories, max_emails }
  returns: { previews: [{ message_id, subject, from, to, date,
                          snippet, labels, has_attachments }, ...] }
  (no DB writes — pure read from Gmail API with filter config applied)

POST /api/connectors/gmail/ingest
  body: { message_ids: [...], thread_mode: 'message'|'thread' }
  returns: { ingested: <count>, deduped: <count>, errors: [...] }
```

FE flow:

1. User opens Gmail config modal → sets filters (sent-only, no promo).
2. FE calls `/preview` → modal shows scrollable list of N rows w/
   checkboxes. Select-all + per-row selection. Subject, from, date,
   snippet visible inline.
3. User clicks **Ingest selected** → FE calls `/ingest` with chosen
   `message_ids`. Backend runs through `GmailAdapter.normalize` with
   the structured-schema path.

### C. Enforce sync config at FETCH time

Currently the config object is logged but Gmail API query params don't
include the filters. Fix in `GmailAdapter.fetchInitial`:

```js
const q = [];
if (config.folders?.length) q.push(config.folders.map(l => `label:${l}`).join(' OR '));
if (config.exclude_categories?.includes('promotions')) q.push('-category:promotions');
if (config.exclude_categories?.includes('social'))     q.push('-category:social');
if (config.exclude_categories?.includes('updates'))    q.push('-category:updates');
if (config.exclude_categories?.includes('forums'))     q.push('-category:forums');
params.set('q', q.join(' '));
```

### D. Drive / Calendar parity

Mirror the preview + ingest split for Drive (file picker → preview
table → selective ingest) and Calendar (date-range preview → selective
ingest).

### E. UI: Memory Graph 2D Sources dropdown → 3D parity

Port the Sources dropdown from `MemoryGraph2D.jsx` to `MemoryGraph.jsx`
(3D). Same `getNodeSource` logic + `hiddenSources` filter applied to
`isNodeVisible` callback before frustum culling.

## Migration path

1. Ship Phase 1 ✅
2. User flushes existing Gmail noise via new endpoint.
3. Build `/preview` endpoint + FE modal.
4. Wire FE Gmail config to use preview-then-ingest by default.
5. Backfill per-provider memory_types for new ingestions.
6. (Optional) Migrate historical memories: replay `gmail_thread_id`
   metadata into the new schema for already-ingested rows.

## Notes

- Soft-delete (`deletedAt = now`) used in flush so a 30-day recovery
  window exists. Hard-delete cron eventually GCs.
- All tags are lowercased and namespaced to avoid collision with
  generic free-text tags ("from:" not "From:").
- Tag explosion concern: long threads w/ many participants could
  produce 20+ tags. Cap at N=20 in `_buildRichTags` next iteration
  if performance regresses.
