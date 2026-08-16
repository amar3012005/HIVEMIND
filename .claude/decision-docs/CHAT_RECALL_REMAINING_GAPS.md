# Chat and Recall — Remaining Gap Register

Status: identified work only. This file deliberately does not implement or authorize these changes.

## P0 — production verification and release coherence

- Cloudflare AI Gateway code can be enabled only after confirming the account ID, Gateway ID, Dynamic Route name, exact custom-provider slugs, BYOK aliases and a scoped token.
- A route canary must verify planner, query rewrite, synthesis, streaming and failure behavior without exposing credentials.
- Gateway response metadata (`cf-aig-model` and `cf-aig-provider`) must be copied into sanitized chat telemetry so production can prove which route branch actually served each stage.
- Source SHA, immutable image, running container and authenticated route must be proven as one release tuple.

## P1 — source-read completeness

- Literal filenames containing parentheses and other punctuation need language-independent metadata resolution.
- Identical source bytes uploaded into evidence-only and both-mode projects can consume multiple evidence slots; logical dedup must retain authorized provenance and prefer the document copy with memory lineage.
- Source overviews need page/section diversity so one repeated section cannot occupy most of the visible window.

## P1 — chunk and evidence quality

- Fast PDF extraction can collapse page boundaries or omit page markers.
- Tables, lists, timelines and product/specification qualifiers are not uniformly kept atomic.
- Chunk-quality acceptance needs coverage, page fidelity, boundary coherence, duplicate rate and retrieval accuracy—not segment count alone.
- German source material is sometimes persisted with incorrect language metadata.

## P1 — remote Memory Box parity

- Central and remote evidence/source status, vector repair, entity-link recovery and operational telemetry need continuing parity verification.
- Maintenance/reconciliation work must not share or starve interactive recall transport capacity.
- Remote unavailability must remain fail-closed without widening into central tenant data.

## P2 — retrieval latency and resilience

- Public quick recall is still above the historical 300–600 ms target on large corpora.
- Provider rerank timeout/fallback rate needs production measurement and alerting.
- Retrieval/projection CAG remains phase two: it requires org/user/project/scope/revision keys and write-driven invalidation before enablement.
- Chat trace must consistently expose one retrieval, one rerank and one synthesis, with a distinct bounded zero-coverage recovery retry when it occurs.

## P2 — synthesis quality

- Broad inventory questions can state the main facts while omitting secondary details even when evidence is present.
- Absence answers need a final coverage guard proving that no delivered passage contains the requested attribute.
- Prompt contribution and provider cache telemetry are not uniformly available across every model/provider response.

## P2 — `use_tools: true`

- Every connected toolkit needs manifest/schema compatibility tests, including null or malformed provider responses.
- Approval UIs must render complete human-readable action arguments for every provider, not only email.
- Continuation recovery needs production tests across Core restart and expired/duplicated resume requests.
- Composio Sessions remains experimental until tool-call usage, robustness, approval parity and native HIVE-MIND tool boundaries are measured against the compound orchestrator.

## Non-goals

- No Solvis-, product-, filename-language- or provider-specific keyword patches.
- No second reranker or automatic 5-to-10-to-15 answer loop.
- No connector writes during model shadowing, canaries or recall tests.
- No tenant-bearing Gateway caching until isolation and revision invalidation are proven.
