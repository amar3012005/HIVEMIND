# Current SINGULANCE Production Release

This file is the deployment ledger. Update it only after production acceptance succeeds.

```yaml
release_id: prod-20260720-72609f55
host: singulance
deployed_at_utc: 2026-07-20T16:00:04Z
parent:
  branch: singulance-main
  sha: 72609f5593ff445cc84b60ed6fc5c2cbb07012e0
frontend:
  sha: 62654d4cd973d9e10082f16f2f6f2a5eaa435330   # FE rebuilt from Da-vinci main (29-commit catch-up) + profile Rebuild button
runtime:
  VERSION: prod-20260720-72609f55
  NEXT_VERSION: prod-20260720-b3ca804a             # frontend unchanged
  env_change: CEREBRAS_API_KEY added post-deploy → synthesis routes Cerebras-direct
              (api.cerebras.ai) instead of gpt-oss via OpenRouter. Core recreated (same
              image, new env). Key is in /root/hivemind/.env only, NOT in the repo.
              OpenRouter sort=throughput remains the fallback path if the Cerebras key is absent.
              PROFILE FLAGS enabled: PROFILE_DREAM_ENABLED, PROFILE_DREAM_APPLY,
              ENABLE_PROFILE_DREAM_CRON, PERSONA_ROUTER_ENABLED = true (activates
              the previously-dark user/org profile subsystem + persona injection).
images:
  core: sha256:22badeecf7c5483d03744b919cd0c0d3ebc0d46432741adb4edafb51a788f362
  control: sha256:830031290c1b4bc60fc95cf607fb08352b53e25e6f49d319f7a5f438e90639e4       # unchanged
  employees: sha256:237d7346d9239f7677517010d81bf244d95f0812a260a285bacc732815690c29     # unchanged
  tara_deepgram: sha256:cf7c25e26e872010b4f443b30dcfbedfb4b52cb100c42e70c25c842f41010876 # unchanged
  frontend_single: sha256:1332c84dd6edb131467c653215c47ff47610219dc1146bd7b5330b3347be5eb1 # prod-20260720-62654d4c-single
migration: none
changes:
  - FRONTEND rebuilt + deployed: Da-vinci origin/main (29 commits ahead of prior gitlink
    1702fa72 — mobile chat rebuild, HyperAgents room/brochure reports, outreach/leads,
    live-listen) + profile Rebuild button. Image prod-20260720-62654d4c-single deployed to
    BOTH FE containers (hm-fe :8088, hivemind-next-frontend-1 :2388) via direct immutable-tag
    recreate (NEXT_VERSION untouched — shared with core/control/employees). Served-bundle
    verified (main.dfc1be31.js live on next.singulancelabs.com). FE rollback: rollback-<ts>-single.
  - PROFILE subsystem activated (was fully built but dark): 4 flags on; ProfileDreamer
    LLM-extracts grounded user+org facts from memories; onboarding mirrors company →
    org-scoped profile facts; new get_user_profile chat tool (caller-scoped, no id from
    model) + 'profile' planner op. Backfill applied (canary: 10 facts incl company=Solvis
    GmbH). Live: profile chat EN grounded; tenant-isolation verified (other tenant → 0).
  - Source-explain / full reconstruction FIXED. Two combined root causes — (1) explicit-source
    hydration was wrapped in withTimeout at CREATION but awaited after hop1/hop2/RRF/boost, so a
    ~50ms hydration always resolved to {timed_out} and fell back to document-lead boilerplate;
    (2) hydration vector-anchored on the raw NL query (filename + question words) so windows landed
    on the cover page, not the entity. Now: raw promise + fresh-clock timeout at the await, and
    anchor on the planner's named entities.
  - Compare / relation per-entity lanes switched from mode:fact (no evidence expansion) to
    mode:explain, limit 5->8, so each entity pulls its document evidence. "Compare X and Y" no
    longer reports both absent when each exists.
  - Chat latency 26-60s (growing/runaway) -> 2.5-7.7s (stable). (1) Qdrant ensureCollection was
    guarded by a scalar collectionReady, invalidated on every multi-tenant switch, re-running
    createPayloadIndex(wait:true) per query -> Set (once per collection per process). (2) OpenRouter
    default routing for openai/gpt-oss-120b landed on 7-15s backends (DekaLLM/WandB/Parasail) ->
    provider.sort=throughput selects Cerebras/Groq at ~0.5-1s. (3) reasoning_effort=low on grounded
    synthesis (medium for full).
  - Every canonical memory now carries the ingest-time (known_at) timestamp: content-body suffix
    (YYYY-MM-DDTHH:MMZ), metadata.recorded_at, ts:YYYY-MM-DD tag, entity first/last-seen via
    CanonicalEntity.createdAt/updatedAt. Idempotent on re-ingest. No migration.
  - Removed proven-dead legacy planner/router (planStep, planPrompt, ROUTER_TOOLS, routerPlan);
    kept callJsonLLM. Added trace.phases per-step latency instrumentation.
  - TEMPORAL wired end-to-end: new 'timeline' planner operation; needs_time_travel derived from
    parsed time fields (was hardcoded false); gatherEvidence dispatches hivemind_diff (range;
    "since X" -> to=now) / hivemind_at (valid_at,known_at) / hivemind_timeline (full history);
    hivemind_timeline resolves by memory_id via the MemoryVersion ledger. SECURITY: memory_id
    path authorizes the anchor + every related row via getMemoryScoped (cross-tenant reads
    refused, probe-verified); hivemind_diff removed rows rendered [REMOVED/SUPERSEDED] so
    superseded values are never asserted as current.
acceptance:
  public: [core_health_ok]
  authenticated:
    - fact_recall_200_grounded_cited
    - source_explain_200_grounded_correct         # was: falsely reported entity absent — FIXED
    - full_reconstruction_200_grounded_correct    # was: falsely reported entity absent — FIXED
    - relation_200_honest_no_edge_vs_comention
    - compare_200_both_entities_found             # was: reported both absent — FIXED
    - german_fact_source_relation_correct_in_de   # no English routing gate
    - temporal_range_200_dispatches_hivemind_diff  # "changed since 2025" — honest no-change answer
    - temporal_asof_200_valid_at_recall            # "as of 2026-06-01" — correct as-of description
    - temporal_history_200_dispatches_hivemind_timeline
    - profile_populated_10_facts_incl_company        # dreamer backfill wrote real facts
    - profile_chat_tool_grounded_en                  # get_user_profile routed + grounded
    - profile_tenant_isolation_other_tenant_zero     # no cross-tenant profile leak
  latency_observed:                                  # after CEREBRAS_API_KEY added (synthesis → Cerebras-direct)
    fact: 2.25-3.25s      # target p95 1.5s — close; ~950ms planner + ~800ms recall + ~500ms synth floor
    explain: 3.65s        # target p95 3s — met/near
    full: 5.46s
    compare: 3.8-6.2s     # flaky: grounded 6-10 sources most runs, occasional thin recall
    relation: 2.5-5.8s
    german: 4.7s
    note: answer_step dropped ~11s → 452-658ms once synthesis routed Cerebras-direct (warm 276-318ms).
  fresh_fatal_errors: 0
  runtime: [core_healthy, exit_0, restarts_0, oom_false]
  known_gaps:
    - Latency above the aggressive p95 targets (fact 1.5s / chat 4s). No longer runaway; residual
      variance is in-answerStep DB work + occasional slow OpenRouter backend despite throughput sort.
    - Temporal now wired end-to-end (timeline op → hivemind_diff/_at/_timeline; tenant-scoped
      memory_id resolution; [REMOVED/SUPERSEDED] marking). Remaining niggle: terse tag-only test
      memories still rank low in semantic recall, and the predecessor→successor Updates EDGE is
      still not written by the update path (only isLatest flags).
rollback:
  core: hivemind/core-api:rollback-20260720T164750Z   # -> prior release e41b46b1
  control: hivemind/control-plane:stable
  employees: hivemind/employees:stable
  tara_deepgram: hivemind/tara-deepgram:stable
  frontend_single: hivemind/fe:stable-single
  immediate_timestamped: 20260720T164750Z
aliases:
  stable: prod-20260720-72609f55
  latest: prod-20260720-72609f55
```

No customer email, connector action, telephone call, or write operation was triggered during release acceptance. The disposable SECURITY_E2E_20260720 test memories (177de683, 65c9ca7b) were intentionally retained as the temporal fixture and NOT deleted.
