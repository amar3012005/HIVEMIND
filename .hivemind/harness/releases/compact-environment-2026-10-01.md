# Compact BRAIN and Dreaming environments — 1 October 2026

## Production identities

- Native source: `267c50846fa27f4a2c5f320f364920f81da69d51`, branch `codex/compact-brain-environment`.
- Runner: `hivemind/harness-chat:sha-267c50846f`.
- Image digest: `sha256:00e79cc343a7a4f0a4d6f77ad4e4e49ad8a1eadf8bc2e6e03ad91bf1135ed550`.
- Compatible base / rollback: `hivemind/harness-chat:sha-4dd9b64b82`, digest `sha256:05253487aa61a4d375bd2e0b3d5f8ef4a86215fcf657e4370cbb96d0f2bc2f20`.
- Original production base retained in source ancestry: `2793c574a253b7175b576ac51cb5c9a06bd9cd60`.
- Runner cutover manifest: `/root/releases/manifests/hyperagents/compact-bottom-267c50846f`.
- Outer frontend: `571886f7bb019d103eb28f7b526d52ffad68b024`, promoted through parent `406cdc15`.
- Worker version: `eed2bbd3-9432-49ab-96e7-77c9df55a27b`.
- Worker previous version: `072c7152-b0c0-4709-a255-c20df20ba52a` (first scale iteration); original preceding release `87a41d94-3854-47a6-a568-014d29695db6`.

## Changes

Removed the connected-app board below the new-session composer. BRAIN and Dreaming use slim top-right Environment panels with Hide and a sliders toggle. Connected apps have small logos; Dreaming retains its server-governed read-only switches, company switch, history, credits and agenda. The redundant BRAIN preset label is omitted from the toolbar only; composer mode selection remains native.

Desktop app scaling uses CSS zoom 0.9 without changing browser preferences. The outer shell and native conversation both use the scaled viewport variable, preventing bottom gaps and horizontal clipping. Native session switching remains resident; the redundant outer resume document reload is removed and the history-fetch status remains accessible without a visible loading-text flash.

Dreaming setup/profile context is hidden in Chat but remains in durable history/inspection. Welcome instructions request assistant text before dream_finish; completed summaries retain the confirmed synthesis. Welcome branding uses HyperAgents, including retained welcome presentation. Authenticated profile supplies names and company; none are hardcoded.

## Evidence

Targeted TypeScript compilation and native mandatory pre-push build/typechecks passed. Immutable Linux/amd64 image verification retained native Schedule, approvals, workspace profiles, streaming, subagents and replay. Runner health is healthy. Cutover checked unchanged sibling container identities; no Core, database, approval or connector permission changes were made.

Authenticated production browser showed the new-session panel, removed board, small app logos, live session credits, working Hide/sliders/Connect-apps disclosure, and in-place selection of an existing conversation. Dreaming showed its persistent welcome and panel with internal setup absent, collapsed exploration/history and HyperAgents wording. Measured viewport width 1920, app width 1920.0001; viewport height 1142, main bottom 1142.2136. No first-time welcome was retriggered: future welcome streaming is configured and compiled, not claimed as observed in a new introduction run.

Screenshots: `/tmp/hivemind-compact-environment-final.png` and `/tmp/hivemind-dreaming-compact-final.png` on the operator workstation.
