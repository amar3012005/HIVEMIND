# Anticipatory integrated release candidate

Prepared artifacts; this record alone does not establish production cutover.

- Harness source: `cc05fe7b40d44b97fb6ccd897d25cce980027386`, pushed branch `codex/anticipatory-integrated-release-20261010`.
- Runner image: `hivemind/harness-chat:sha-cc05fe7b40-anticipatory-integrated`.
- Verified image ID: `sha256:5c24a03f76c4597b2eeaedf1941e987d54a3c7210386178d3cd29fd39e12395c`.
- Compatible base/rollback: `hivemind/harness-chat:sha-0b3f3f7d38-cold-metadata`, ID `sha256:5ba8c0257f82ea5e480bcb9ba2498ca163175117c28c92b05fdd87fb69f12c98`.
- Provenance: `/root/releases/anticipatory-integrated-cc05fe7b40/context/provenance.json`.
- Changes include cold chat/provider batching, five-turn first page, nightly native skill, signal rows, voice strip/ringback, generic native decision service, and old v2 attention compatibility.
- Full normal pre-push host build and client typecheck passed; 65 integrated focused tests passed.
- Immutable real scoped DB canary: 493-room navigation 94 ms/9 queries; snapshot 83 ms/66 queries, exactly five turns, older history available. Only an audit script was mounted; provider and controller code came from the image.
- Explicit selected decision route: direct native OpenRouter alpha endpoint, enabled through `HIVEMIND_DECISION_ENABLED=1`, `HIVEMIND_DECISION_ENDPOINT=https://openrouter.ai/api/alpha/decisions`, `HIVEMIND_DECISION_API_KEY_REF=JEV_OPENROUTER_API_KEY`. Existing credential remains managed and untouched; gateway references remain unset. No fallback.
- Core native attention switch requires successful authenticated live native assessment first.
- Outer frontend gitlink: `e07efe81985705391384214d0b3c07112b672546`, independently promoted to Da-vinci `main`; parent `0f85ef569` recorded that pin.
- Root owns all live cutovers. Managed runner helper records the complete prior Compose-chain rollback command, validates only image plus explicit decision settings changes, preserves memory/security/environment, checks zero active turns and sibling identities.
- Remaining acceptance: authenticated live chat/reload/loading, voice call/cleanup/mobile, nightly existing-schedule upgrade and actual replies/report receipt, private Slack/Gmail correlation, and blocked-agent pause/resume.
