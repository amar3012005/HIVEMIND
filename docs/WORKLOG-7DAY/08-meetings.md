# 08 — AI Meeting Notes

New page + backend. Landed **Jun 2**.

## Commits

| SHA | Summary |
|-----|---------|
| `00fe69f` | org-level persistent meetings table + REST routes |
| `6a0a235` | read user/org from headers (principal TDZ at route location) |
| `5e8aaaf` | toggleable pyannote multi-speaker diarization |
| `658858d` | Whisper accuracy config — temperature 0, auto-detect language |
| FE `daa226e` | self-hosted AaaS voice widget on /tara + AI Meeting Notes page |
| FE `647b0a4` | control-room redesign — realtime rotating meeting wheel |
| FE `f3d6a7b` / `e84d624` | dark 'control deck' → light HIVEMIND theme |
| FE `ac39496` | multi-speaker recognition toggle + speaker-labeled transcript |
| FE `c599faf` | persist + read from org meetings table; structured detail |

## What was built

### Backend
- **Org-level persistent meetings table** + REST routes (list/detail/create).
- User/org read from headers (fixed a principal TDZ — temporal-dead-zone — bug
  at the route location).
- **Multi-speaker diarization** via pyannote, toggleable per meeting →
  speaker-labeled transcript.
- Whisper tuned for accuracy: temperature 0 + auto-detect language.

### Frontend
- AI Meeting Notes page rebuilt in the light HIVEMIND theme (matches Workspace Admin).
- Control-room aesthetic with a realtime rotating meeting wheel.
- Multi-speaker toggle + structured meeting detail, persisted to the org table.

## Status / open
This is the page the user flagged as **"worse" and wants fully redesigned** into a
high-end dashboard (past meetings, recording animation, insights, dial hover,
dates/days). That redesign is **forward work** — see STRATEGY.md. The current
page is functional but UI is the weak point.
