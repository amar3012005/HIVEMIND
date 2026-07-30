# Phase 3 Journal: Runtime-First HQ Interface

Date: 2026-07-30

## Completed

- Replaced the HQ-only report-first center blocks with a persistent runtime
  header and real operational event stream.
- Added activation, wake, pause, and resume controls.
- Added SSE with persisted-event polling fallback.
- Moved detailed Baseline and Growth Plan views into Company Resources without
  deleting or redesigning the retained reports.
- Replaced the old two-step setup rail with compact runtime state, current Work
  Orders, and scheduled wakes.
- Added descriptor-first HQ skills and toolkit catalog; full skill bodies are
  separate files loaded only after selection.

## Compatibility

The render change is guarded by `isHqRoom`. General user-created Rooms,
specialist Rooms, Campaign Intelligence, SEO, Room SSE, composer behavior, and
voice components remain on their existing paths.

## Verification

The complete CRA production build passed under Node 20. Existing repository
lint warnings remain; no new compile failure was introduced.
