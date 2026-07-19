# Current SINGULANCE Production Release

This file is the deployment ledger. Update it only after production acceptance succeeds.

```yaml
release_id: prod-20260719-c98a7427
host: singulance
deployed_at_utc: 2026-07-19T18:15:34Z
parent:
  branch: singulance-main
  sha: c98a742762482dbf493dc7bc133a48121e5c4a07
frontend:
  declared_gitlink_sha: 1702fa72952c2ae74dae7a7b47950737417e1863
  recreated: true
runtime:
  VERSION: prod-20260719-c98a7427
  NEXT_VERSION: prod-20260719-c98a7427
images:
  core: sha256:f0b3e98e8044d0e64a9b743f07e61596840c7b8faf7108a04ef8e3c9e4770dea
  control_unchanged: sha256:edfedbab3f5938d0ad218fb93bfb08f15b8fc36b909c4f2292fc4413ae646172
  employees_unchanged: sha256:53736acfd6d6c42c27041d7f28bd84722efd96e8228f8c424c1d43547ac30a24
  tara_deepgram_unchanged: sha256:ee371b7bb007742f60ead7ab2db96c547b8014808ca8a901d94465527866469b
  byod_broker_unchanged: sha256:ae0fe36a8468690f7c0da07a1af5ae608d069fd3f8b8e1d4d2b6088706340eee
  playwright_unchanged: sha256:4177c43a4414d50b0028a957c85bce332201fc5a1c72fbbbc65179dd5144ee94
  frontend_single: sha256:fcbf0022382f9a04656f69660f4f92fb6760d40efff9468188e23749bcf7cd0a
migrations: []
changes:
  - Deterministic chat recall controls now pass through Toolkit validation while arbitrary hidden arguments remain rejected.
  - Explicit chat project scope reaches the shared recall service and inaccessible projects fail closed before retrieval.
  - Projectless recall retains personal, organization, team, and every project memory already authorized by access_context.
  - Legacy STRICT LANGUAGE message prefixes are stripped before intent and recall; language remains a dedicated parameter.
  - Intent routing defaults to the fast internal 20B model; final synthesis honors the caller-selected model and defaults to GPT-OSS 120B.
acceptance:
  production_image_tests: 19/19
  authenticated_scoped_chat:
    project: 66275318-c11c-4dcb-b6a9-457b43c3bfda
    result: 5 memories plus source-specific expansion with 3 evidence passages
    total_ms: 3851
  authenticated_all_authorized_chat:
    result: SolvisPia project evidence found without an explicit project
    total_ms: 4845
  unauthorized_project: 403 project_access_denied
  legacy_language_prefix:
    recall_query_clean: true
    german_response: true
    total_ms: 3785
  selected_final_model:
    model: openai/gpt-oss-20b
    helpful_partial-evidence_response: true
    total_ms: 25861
  served_frontend:
    project_payload_bundle_markers: 7
    legacy_language_prefix_constructors: 0
    local_status: 200
    public_status: 200
  bounded_recall:
    unscoped_count: 4
    unscoped_ms: 1186
    scoped_warm_count: 4
    scoped_warm_ms_range: 651-752
  public_200: [hivemind_home, login, overview, api_health, core_health]
  core_health: healthy
  fresh_fatal_errors: 0
residual_risks:
  - The first cold scoped fact recall reached the strict 1.5 second deadline and returned cutoff_reason=latency_budget; warm calls returned four memories below 0.8 seconds.
  - A caller-selected 20B final synthesis completed correctly but took 25.9 seconds; the default 120B path completed in 3.9-4.9 seconds during this acceptance.
untested_side_effects:
  - No customer writes, connector actions, or memory mutations were performed.
rollback:
  core: hivemind/core-api:rollback-20260719T180937Z
  frontend: hivemind/fe:rollback-20260719T182735Z
  env_backup: /root/hivemind/.env.bak-prod-20260719-c98a7427
```
