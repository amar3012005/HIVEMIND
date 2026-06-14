# AI Meeting Notes — Complete Reference

> Record a meeting → transcribe → extract structured insights → save as
> first-class, graph-linked memory. The web app (`/hivemind/app/meeting-notes`)
> captures audio in the browser, the backend does Whisper transcription +
> optional speaker diarization + LLM insight extraction, persists a structured
> `meetings` row, and (on "Save to HIVEMIND") ingests an entire memory **tree**
> so decisions/actions/risks each become typed, linkable memories.
>
> Sovereign by construction — audio only ever hits our own transcription
> endpoint, never a third-party browser ASR.
>
> Verified against the codebase 2026-06-14.

---

## 0. File map (jump table)

| Concern | File | Key symbols / lines |
|---|---|---|
| **Web-app page (record UI + flow)** | `frontend/Da-vinci/src/components/hivemind/app/pages/MeetingNotes.jsx` | `start` (capture), `process` (transcribe→insights), `persistRow`, `save`/ingest |
| Sidebar entry | `…/app/layout/Sidebar.jsx` | `/hivemind/app/meeting-notes` → "AI Meeting Notes" |
| Route | `…/app/HiveMindApp.jsx` | lazy `MeetingNotes` |
| **Transcribe** | `core/src/server.js` | `POST /api/meetings/transcribe` :5171 |
| **Insights** | `core/src/server.js` | `POST /api/meetings/insights` :5264 |
| **List / persist** | `core/src/server.js` | `GET/POST /api/meetings` :5298/:5320 |
| **Detail** | `core/src/server.js` | `GET /api/meetings/:id` :5355 |
| **Link / amend** | `core/src/server.js` | `PATCH /api/meetings/:id` :5381 |
| **Save to HIVEMIND (smart tree)** | `core/src/server.js` | `POST /api/meetings/:id/ingest` :5414 |
| Diarization helpers | `core/src/server.js` | `pyannoteDiarize`, `alignSegmentsToSpeakers` |
| **Table** | `core/prisma/migrations/20260602230000_meetings/migration.sql` (+ `20260610200000_meeting_notes_insights`) | `meetings` |
| Enterprise schema (KB-ingested meeting docs) | `core/src/knowledge/enterprise/schemas/meeting.js` | `meetingSchema` |

---

## 1. What it is

A full record→understand→remember loop for meetings, living on its own
dashboard page. Three things make it more than a transcriber:

1. **Dual-side capture in the browser** — not just your mic; it can capture the
   *other participants'* audio from a Google Meet / Zoom-web tab (no extension).
2. **Structured insights** — summary, action items (owner/due), decisions, key
   points, risks, next steps, questions, topics, sentiment, quotes, entities.
3. **Graph-native memory** — "Save to HIVEMIND" doesn't dump a blob; it ingests
   a **tree** of typed memories (each decision/action/risk separately) that
   auto-link to existing people/orgs and prior decisions, and are recall-boosted
   by type.

---

## 2. End-to-end pipeline

```
 ┌─ BROWSER (MeetingNotes.jsx) ──────────────────────────────────────────────┐
 │  Capture audio (one of):                                                   │
 │   • Microphone only  → getUserMedia({audio})                               │
 │   • This call (tab+mic) → getDisplayMedia({audio}) ⨁ mic, merged via       │
 │                           AudioContext destination                          │
 │  MediaRecorder → audio/webm;opus blob                                       │
 └──────────────┬─────────────────────────────────────────────────────────────┘
                │ POST /api/meetings/transcribe?diarize=&prompt=  (raw audio body)
                ▼
 ┌─ CORE ────────────────────────────────────────────────────────────────────┐
 │  1. Groq Whisper (whisper-large-v3, verbose_json, temp 0, auto-language)    │
 │     → { transcript, language, segments[], bytes }                          │
 │  2. (opt) ?diarize=true + PYANNOTE_API_TOKEN → pyannote turns →             │
 │     align to Whisper segments → speakerSegments[] (SPEAKER_xx)             │
 └──────────────┬─────────────────────────────────────────────────────────────┘
                │ POST /api/meetings/insights { transcript|labeled, notes }
                ▼
 │  3. LLM (gpt-oss-120b, JSON mode, temp 0.2) → insights{...}                │
                │ POST /api/meetings  { title, transcript, insights, … }
                ▼
 │  4. Persist row in `meetings` (auto, on finish) + GET /api/meetings list   │
                │ POST /api/meetings/:id/ingest   ("Save to HIVEMIND")
                ▼
 │  5. ingestMemoryTree: parent `event` + typed children (decision/goal/fact) │
 │     → smart-router → embed → Qdrant → relation-classify → graph links      │
 └────────────────────────────────────────────────────────────────────────────┘
```

Stage 4 (persist) happens **automatically** the moment a recording finishes —
the meeting is saved to the Past tab regardless of whether the user later
clicks "Save to HIVEMIND" (stage 5, which additionally turns it into memory).

---

## 3. Capture modes (browser)

`MeetingNotes.jsx` → `start()`. Mic is ALWAYS part of the recording (your
voice); the source toggle decides whether tab audio is mixed in.

| Mode | How | Captures |
|---|---|---|
| **Microphone only** (default) | `getUserMedia({audio:{echoCancellation,noiseSuppression,autoGainControl}})` | just you (in-person / phone) |
| **This call (tab + mic)** | `getDisplayMedia({video:true,audio:true})` → take the audio track, **drop the video track**, merge with mic via `AudioContext.createMediaStreamDestination()` | you **+** the other participants on a Meet/Zoom-web tab |

Tab-capture rules baked in:
- The picker needs `video:true` to offer audio; the video track is stopped
  immediately (audio-only, low overhead).
- The user must pick a **TAB** and tick **"Share tab audio"** — if no audio
  track comes back, a clear error tells them exactly that.
- If the user hits Chrome's **"Stop sharing"** bar, the display track's `ended`
  event auto-stops the recording.
- All raw streams + the AudioContext are torn down in `cleanup()`.

> The web app can only grab tab audio when the user shares the tab via the
> picker each time. The Chrome extension (separate, later) makes this automatic.

---

## 4. Models & external services

| Stage | Service | Model / detail | Env |
|---|---|---|---|
| Transcription | Groq Whisper | `whisper-large-v3` (lowest WER 10.3%), `verbose_json` (segment timestamps), `temperature 0`, **language auto-detected** | `GROQ_API_KEY`, `GROQ_WHISPER_MODEL`, `GROQ_WHISPER_MAX_MB` (24) |
| Diarization (opt) | pyannote | multi-speaker turns, aligned to Whisper segments; graceful fallback to plain transcript on any failure | `PYANNOTE_API_TOKEN` |
| Insights | Groq LLM | `openai/gpt-oss-120b`, JSON mode, `temperature 0.2` | `GROQ_API_KEY`, `MEETING_INSIGHTS_MODEL`, `GROQ_BASE_URL` |

**Whisper prompt biasing:** the user's pre-meeting notes are passed as
`?prompt=` (capped ~800 chars) so Whisper spells names/companies/jargon
correctly.

**Resilience:** the transcribe call retries transient Groq failures (429 / 5xx /
network / timeout) up to 3× with exponential backoff, honoring `Retry-After`.
Terminal errors (400/413/415) return specific, actionable messages instead of an
opaque 502 — e.g. a too-large recording returns `audio_too_large` (413) with the
exact MB over the limit.

---

## 5. API reference

### `POST /api/meetings/transcribe?diarize=<bool>&prompt=<ctx>`
Raw audio in the request **body** (`Content-Type: audio/webm`). →
```json
{ "transcript": "...", "language": "en", "segments": [...], "bytes": 123456,
  "diarized": true, "speakerSegments": [{ "speaker": "SPEAKER_00", "text": "...", "start": 0.0, "end": 4.2 }] }
```
Errors: `stt_unavailable` (503, no key), `empty_audio` (400), `audio_too_large`
(413), `transcription_busy` (503, 429), `audio_unsupported` (400), `whisper_failed` (502).

### `POST /api/meetings/insights` `{ transcript, notes? }`
→ `{ insights: { … } }`. The insights object:
```jsonc
{
  "title": string,
  "summary": string,              // 3–6 sentences
  "key_points": string[],
  "action_items": [{ "task": string, "owner": string|null, "due": string|null }],
  "decisions": string[],
  "questions": string[],
  "topics": string[],
  "sentiment": string,
  "quotes": [{ "quote": string, "speaker": string|null }],   // ≤5 verbatim, original language
  "risks": string[],              // blockers / red flags
  "next_steps": string[],         // follow-ups beyond action items
  "entities": { "people": string[], "organizations": string[], "dates": string[] },
  "speaker_names": { "SPEAKER_00": "Matthias" }   // diarization-label → real name, when inferable
}
```
The system prompt enforces faithfulness ("never invent facts", empty
arrays/objects when none) and only maps `speaker_names` when notes/context name
the participants.

### `GET /api/meetings?limit=40`
Light list (no transcript/notes/insights) for the **Past meetings** tab, newest
first, org-scoped.

### `POST /api/meetings`
Persist a structured row. Body: `{ title, transcript, language, multi_speaker,
speaker_count, segments, source_memory_id, insights, notes, duration_sec,
audio_bytes, project_id }`. Auth via `x-hm-user-id` / `x-hm-org-id` headers.
Requires a non-empty transcript **or** an insights summary. → `{ ok, id, created_at }`.

### `GET /api/meetings/:id`
Full row including transcript + insights (the detail view fetches this on open).

### `PATCH /api/meetings/:id`
Link a saved memory (`source_memory_id`) or amend fields.

### `POST /api/meetings/:id/ingest`  ("Save to HIVEMIND")
The smart-tree ingest (§7). Idempotent via `meetings.source_memory_id`; pass
`{ force: true }` to re-ingest.

---

## 6. The `meetings` table (Postgres, org-level)

`core/prisma/migrations/20260602230000_meetings` + `…_meeting_notes_insights`.
Written by raw SQL so it works without a Prisma client regen on the running image.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `user_id`, `org_id`, `project_id` | uuid | tenant scope |
| `title`, `summary`, `transcript` | text | |
| `language` | varchar(16) | Whisper auto-detected |
| `duration_sec`, `audio_bytes` | int | |
| `multi_speaker` | bool | diarization ran |
| `speaker_count` | int | distinct speakers |
| `action_items`, `decisions`, `key_points`, `questions` | jsonb | dedicated columns |
| `segments` | jsonb | diarized speaker segments |
| `topics` | text[] | |
| `sentiment` | varchar(32) | |
| `notes` | text | the user's own typed notes |
| `insights` | jsonb | the COMPLETE insights blob (renders every section incl. quotes/risks/next_steps) |
| `source_memory_id` | uuid | parent memory after "Save to HIVEMIND" (also the idempotency key) |
| `created_at`/`updated_at`/`deleted_at` | timestamptz | soft delete |

Indexes: `(org_id, created_at desc)`, `(user_id)`.

---

## 7. "Save to HIVEMIND" — the smart memory tree

`POST /api/meetings/:id/ingest` does NOT save one flat markdown blob. It builds
a **tree** from the already-extracted insights and runs every node through the
canonical ingest pipeline (smart-router → embed → Qdrant → relation-classify):

- **Parent** — `event` memory: summary + participant/org **entity tags** +
  meeting-date temporal anchor. Tagged `meeting`, `ai-meeting-notes`,
  `meeting:<id>`.
- **Children** (each a first-class typed memory, tagged `meeting:<id>`):
  - each **decision** → `decision` memory (+ top topics)
  - each **action item** → `goal` memory (owner/due in content)
  - each **key point** → `fact` (`key-point`)
  - each **risk** → `fact` (`risk`)
  - each **next step** → `goal` (`next-step`)
  - the **transcript** → ONE low-priority `event` grounding child (`transcript`,
    auto-tagged `extracted-fact` so it's hidden from the default list)
- Participants come from the diarization `speaker_names` map + insight entities
  → `entity:<Person>` / `entity:<Org>` tags.

**Why a tree:** because each decision/action runs the same canonical pipeline, a
decision here auto-links (`Updates`/`Contradicts`) to prior decisions on the same
topic, and entity tags connect the meeting to existing people/org clusters in the
graph. A flat blob would do none of that.

After ingest, the parent memory id is written back to `meetings.source_memory_id`
(idempotent) and structured enrichment is enqueued on the parent.

---

## 8. How it surfaces in recall

- Meeting memories carry rich tags (`ai-meeting-notes`, `meeting:<id>`,
  `entity:<Person>`, `entity:<Org>`, `decision`/`risk`/`key-point`/`next-step`,
  topic tags) → caught by vector + entity-facet + FTS recall alongside docs.
- Typed children are **type-boosted** in recall (a `decision`/`goal` ranks for
  "what did we decide about X" / "what are my action items").
- The transcript child is low-priority grounding — present for citation, hidden
  from the default Memories list.
- Past meetings tab reads the structured `meetings` table directly (not recall),
  so meetings are browsable even before "Save to HIVEMIND".

---

## 9. Limits & gotchas

- **25 MB Whisper cap** (`GROQ_WHISPER_MAX_MB`, default 24) — a long meeting is
  the #1 failure. Caught with a clear `audio_too_large` message; record shorter
  segments or split. (Chunked long-meeting transcription is a future upgrade.)
- **Diarization is opt-in** — needs `?diarize=true` AND `PYANNOTE_API_TOKEN`;
  any failure silently falls back to a plain (un-labeled) transcript.
- **Tab audio is per-share** — the web app needs the user to pick the tab +
  enable "Share tab audio" each recording. The Chrome extension will automate it.
- **Language auto-detected** — Whisper omits the language param on purpose;
  German/multilingual meetings transcribe natively, surfaced back as `language`.
- **Insights faithfulness** — the prompt forbids inventing facts; empty
  sections come back as empty arrays, not hallucinated filler.

---

## 10. Quick verification (prod)

```bash
# List a user's meetings
curl "$CORE/api/meetings?limit=5" -H "X-API-Key: $KEY" -H "X-HM-Org-Id: $ORG"

# Transcribe a local clip (raw body)
curl -X POST "$CORE/api/meetings/transcribe" \
  -H "X-API-Key: $KEY" -H "Content-Type: audio/webm" --data-binary @clip.webm

# Insights from a transcript
curl -X POST "$CORE/api/meetings/insights" -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" -d '{"transcript":"...", "notes":"Acme QBR, attendees: Uwe, Amar"}'

# DB state
SELECT id, title, language, multi_speaker, speaker_count, source_memory_id, created_at
FROM meetings WHERE org_id='<uuid>' ORDER BY created_at DESC LIMIT 5;
```

The browser capture path (`getUserMedia` / `getDisplayMedia`) is a real-gesture
API — it can't be exercised headless; verify with a live click-through on the
Meeting Notes page.

---

## 11. Roadmap (not yet built)

- **Chrome extension** — auto-detect Meet/Zoom/Teams, one-click capture with
  `tabCapture` + offscreen document (no manual tab-share), feeding the SAME
  `/api/meetings/*` pipeline. (Plan exists; web app ships ~80% of the value now.)
- Chunked transcription for meetings over the Whisper size cap.
- Live in-page interim transcript while recording.
