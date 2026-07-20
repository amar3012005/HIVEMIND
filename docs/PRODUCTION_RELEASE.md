# Current SINGULANCE Production Release

This file is the deployment ledger. Update it only after production acceptance succeeds.

```yaml
release_id: prod-20260720-08f01b38
host: singulance
deployed_at_utc: 2026-07-20T15:11:43Z
parent:
  branch: singulance-main
  sha: 08f01b381771d76b78920e26fa9ffea3bb83e3fa
frontend:
  sha: 1702fa72952c2ae74dae7a7b47950737417e1863   # unchanged — Core-only release
runtime:
  VERSION: prod-20260720-08f01b38
  NEXT_VERSION: prod-20260720-b3ca804a             # frontend unchanged
  env_change: CEREBRAS_API_KEY added post-deploy → synthesis routes Cerebras-direct
              (api.cerebras.ai) instead of gpt-oss via OpenRouter. Core recreated (same
              image, new env). Key is in /root/hivemind/.env only, NOT in the repo.
              OpenRouter sort=throughput remains the fallback path if the Cerebras key is absent.
images:
  core: sha256:b66b7f8ec300727194bf9756e989f7a1806564ff596ad8486cbc58f30e9f0a69
  control: sha256:830031290c1b4bc60fc95cf607fb08352b53e25e6f49d319f7a5f438e90639e4       # unchanged
  employees: sha256:237d7346d9239f7677517010d81bf244d95f0812a260a285bacc732815690c29     # unchanged
  tara_deepgram: sha256:cf7c25e26e872010b4f443b30dcfbedfb4b52cb100c42e70c25c842f41010876 # unchanged
  frontend_single: sha256:0ba7d5378c37e9269339903d89115abaa90220a9825f2096d8c90739f42dcfd4 # unchanged
migration: none
changes:
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
acceptance:
  public: [core_health_ok]
  authenticated:
    - fact_recall_200_grounded_cited
    - source_explain_200_grounded_correct         # was: falsely reported entity absent — FIXED
    - full_reconstruction_200_grounded_correct    # was: falsely reported entity absent — FIXED
    - relation_200_honest_no_edge_vs_comention
    - compare_200_both_entities_found             # was: reported both absent — FIXED
    - german_fact_source_relation_correct_in_de   # no English routing gate
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
    - Temporal valid_at/known_at not proven end-to-end: base recall does not surface the terse
      SECURITY_E2E test memories ("launches on 2027-06-01"); partly a synthetic-test-data artifact.
      Also: the claimed Updates edge between predecessor/successor does NOT exist in the DB — only
      isLatest flags wire the supersession.
rollback:
  core: hivemind/core-api:rollback-20260720T151143Z   # -> prior release 5e347266
  control: hivemind/control-plane:stable
  employees: hivemind/employees:stable
  tara_deepgram: hivemind/tara-deepgram:stable
  frontend_single: hivemind/fe:stable-single
  immediate_timestamped: 20260720T151143Z
aliases:
  stable: prod-20260720-08f01b38
  latest: prod-20260720-08f01b38
```

No customer email, connector action, telephone call, or write operation was triggered during release acceptance. The disposable SECURITY_E2E_20260720 test memories (177de683, 65c9ca7b) were intentionally retained as the temporal fixture and NOT deleted.
