# P11 — AI Meeting Notes audit (MeetingNotes.jsx, 349 lines)

## Already present (FINISH/polish, do NOT rebuild)
- Record flow: MediaRecorder → `/api/meetings/transcribe?diarize=` (Groq Whisper + optional pyannote) → `/api/meetings/insights` (gpt-oss) → Save to HIVEMIND + `/api/meetings`.
- Tabs: `record` | `past`. Past meetings load from `/api/meetings?limit=40`.
- Components: `ClockChip` (live), `Waveform` (recording animation, mn-eq keyframes), `StatCard`, `Panel`, multi-speaker toggle + speaker-colored segments, `fmtDate` (weekday/day/month/time).
- Detail view with `detailTab` (summary / …), insights (action_items, decisions, topics).

## Gaps vs desired "high-end dashboard" (P12 scope — elevate, surgical)
1. **Dial hover** — no radial/dial control or hover affordance. Add a circular record dial w/ hover states.
2. **Past-meetings richness** — list is plain; wants calendar/timeline by dates+days, hover previews.
3. **Visual identity** — generic; wants glass-morphism, depth, premium control-deck aesthetic (frontend-design skill).
4. **Insights presentation** — action_items/decisions/topics shown plainly; wants structured insight cards + counts.
5. **Recording animation** — Waveform exists but basic; elevate to a reactive orb/rings during capture.
6. **Empty/loading states** — polish skeletons.

## P12 plan (FINISH existing component, frontend-design skill, no rewrite)
- Keep ALL existing logic/handlers/api calls untouched; restyle + add dial/timeline/insight-cards.
- One PR on Da-vinci → push → bump submodule → Vercel auto-build → human visual review (cannot agent-verify).
- Risk: frontend-only, cannot break backend. Rollback = revert Da-vinci commit + submodule bump.

## Status
P11 audit COMPLETE. P12 (implementation) = dedicated focused frontend-design run + your visual review — not rushed into depleted budget (would be patchwork).
