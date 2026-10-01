# Overview and Dreaming boot optimization

Frontend source: `2640e28debba1f47f4939e4dd500ccdc98d65918` (`codex/faster-workspace-boot`, promoted to origin/main).
Worker version: `cf04eead-615d-4f1a-8155-415b18bd1700`.
Rollback Worker: `eed2bbd3-9432-49ab-96e7-77c9df55a27b`.
Native runner unchanged: `hivemind/harness-chat:sha-b7635827b7`.

Three focused frontend owners changed. Boot preloads external script sources and the revision-pinned shell, runs ordered injections alongside stylesheet loading, and waits for both before mounting. Revision mismatch reload and native teardown ordering remain intact. Dreaming reuses its freshly established secure session; authoritative boot 401/403 triggers one re-admission attempt. Overview resume renders a loader until its redirect instead of mounting and disposing the native app twice. Existing Dreaming rooms skip unused onboarding-avatar fetches.

Production frontend build and release guard passed. Source was clean and based on latest frontend origin/main. Existing authentication, legacy rollout fallback, fresh-session semantics, profile isolation and native readiness gates preserved. No secrets or tenant boot state cached in persistent storage. No numerical speed claim: DevTools network/trace tools were unavailable; removed request and dependency boundaries established from code, with authenticated page verification recorded separately.

Authenticated browser proof: Overview composer became usable, three boot preloads were present, Overview → Dreaming opened the persistent conversation with dated synthesis/Flashback cards and controls, and Dreaming → Overview returned to the usable composer. Screenshots: `/tmp/hivemind-faster-overview.png`, `/tmp/hivemind-faster-dreaming.png`. Runner remained healthy on unchanged b7635827b7. No extra Dreaming run or connector access changes were made.
