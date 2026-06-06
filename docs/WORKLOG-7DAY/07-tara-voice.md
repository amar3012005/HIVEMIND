# 07 — TARA (voice agent)

Self-hosted AaaS voice orchestrator (FastAPI) + HIVEMIND-grounded conversation.
Landed **Jun 2–5**. Heaviest FE churn of the week.

## Backend commits

| SHA | Summary |
|-----|---------|
| `05658ce` | call history + per-turn usage + per-call insights (org-scoped) — models, migration, ingest endpoints |
| `b423e24` | strict memory-grounding (anti-hallucination) + internal/external mode gate |
| `e3b993e` | top-level language directive prepended to system prompt |
| `8cb0280` | internal mode speaks as the voice of HIVEMIND (full disclosure, human) |
| `cbf3095` | Skills — named prompt presets (external primary+secondary / internal voice) |
| `476cf00` | skills use 'fact' MemoryType, distinguished by tara-skill tag |
| `62f2e41` | greeting turn — opening line in selected language + active skill persona |
| `2d3c8eb` | sticky selected language across turns + clinical user_type/directive |
| `9171399` | force clinical user_type/directive fields (prompt-independent) |
| `7455c8c` | isolate voice activity — one call-log per call, exclude from recall + graph + list |
| `7cffdf5` | vendor voice orchestrator into repo (services/tara-aaas) + redeploy script |

## What was built

### Skills (named prompt presets)
- **External** = client/employee-facing (primary + secondary prompt).
- **Internal** = the private "voice of HIVEMIND" (full disclosure, human tone).
- Active external skill + active internal skill are **org-wide**; the voice
  widget's toggle reflects whichever skill is selected per side.

### Language stickiness + greeting
- Top-level language directive prepended to the system prompt (same underlying
  persona, any selected language).
- Conversation **starts with a Tara greeting** in the selected language + active
  skill persona, and the language sticks across turns.

### Clinical reasoning (forced contract)
- SPICED-style clinical reasoning with `user_type` (Director/Socializer/Thinker/
  Relater) + directive — forced as fields **independent of the prompt** so it
  can't be skipped. Internal mode skips clinical (direct recall instead).

### Activity isolation (graph noise fix)
- TARA turns were flooding the memory graph. Now: **one call-log memory per call**,
  excluded from recall + graph + list views. `tara/*` projects + `tara-*` tags
  filtered from all retrieval surfaces. Call history / usage / insights persisted
  to dedicated `tara_calls` / `tara_turns` / `tara_insights` tables (Postgres only).

### Vendored orchestrator
- `services/tara-aaas/` (voice_ws.py + tara_stream.py): Groq STT + Cartesia TTS,
  language + skill aware greeting, redeploy script. Previously lived only on the
  box at `/opt/tara-aaas` — now in-repo.

## FE highlights
ElevenLabs-style Three.js orb with mic/playback RMS reactivity; Skills card grid
with glassmorphism lucide tiles; Call History / Insights / Usage tabs wired to
real per-call data; selected-voice fix on Start.
