# Codex HIVE-MIND Wrapper Journal

Date: 2026-03-12

## Objective
- Add a simple local wrapper so Codex can store and recall memory against the live HIVE-MIND API without relying on MCP client integration.

## Implementation
1. Added `scripts/codex-hivemind.js` with three commands:
- `remember`
- `recall`
- `session-save`
2. Defaulted the wrapper to:
- `HIVEMIND_API_URL=http://localhost:3000`
- `HIVEMIND_API_KEY` or `KEY` for auth
3. Wired commands to persisted API routes:
- `remember` -> `POST /api/memories`
- `recall` -> `POST /api/recall`
- `session-save` -> `POST /api/ingest`

## Expected Use
- This gives the local Codex workflow a direct memory adapter.
- The wrapper is suitable for terminal use and future automation from this workspace.
