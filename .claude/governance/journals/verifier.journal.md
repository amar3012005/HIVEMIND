# verifier.journal

Running log of real-box verifications. Newest at top.

## 2026-06-26 — self-host register e2e (B3)
BOOT: core=0 control=0
ISOLATION: registry file absent → all orgs managed (inert) ✓
SMOKE: register (throwaway org, throwaway PG) → {ok:true, migrated:true}; registry file written;
       customer PG curated schema applied (memory tables present).
MANAGED GATE: sai recall ("Zebra") → returned the memory ✓
CLEANUP: registry file removed, throwaway org+key+PG deleted → prod inert.
VERDICT: GREEN.

## 2026-06-26 — context proxy deploy (B4)
BOOT: core=0 control=0
SMOKE: managed recall (Zebra) → real result; control-plane /health (captured prisma → proxy) → 200.
MANAGED GATE: sai ingest 202 + recall round-trip ✓
VERDICT: GREEN.

## (scar) the bug this crew exists for
conformance was 16/16 GREEN while the FTS lexical leg `$queryRaw`-passthrough hit the empty central PG
for the `.amr` org — recall silently degraded. Unit-green ≠ correct. Always the managed/real-box gate.

## 2026-06-27 — Phase 2b
- RED #1: createMemory skip → createSourceMetadata FK (P2003, no central parent). → gated subgraph writes.
- RED #2: createMemory skip → applyExtends "requires source and target" (mid-ingest getMemory found row NOWHERE). → ARCHITECT re-plan: createMemory pushes row to agent NOW (vector later via storeMemory upsert).
- GREEN: save → central Δ0, agent Δ+1 (vector_synced=t), ingest completes, list reads from agent.
- managed gate: structural — gates fire only for orgIsRemote=true; only d49c9385 registered → all other orgs run original code path verbatim.
- residuals: enrichment-queue central source_metadata write errors for remote (best-effort, non-fatal); stale agent Qdrant test points (recall noise).
