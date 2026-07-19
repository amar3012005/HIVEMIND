# Current SINGULANCE Production Release

This file is the deployment ledger. Update it only after production acceptance succeeds.

```yaml
release_id: prod-20260720-9937c452
host: singulance
deployed_at_utc: 2026-07-19T19:08:33Z
parent:
  branch: singulance-main
  sha: 9937c4521504daca3657e1427b0a3d2fb9488d1e
frontend:
  declared_gitlink_sha: 1702fa72952c2ae74dae7a7b47950737417e1863
  recreated: true
runtime:
  VERSION: prod-20260720-9937c452
  NEXT_VERSION: prod-20260720-9937c452
images:
  core: sha256:f8592d488f4dc50b40f4579cd74ea38470fa5657ac5f141dfa2efabfddf83d1d
  control_unchanged: sha256:edfedbab3f5938d0ad218fb93bfb08f15b8fc36b909c4f2292fc4413ae646172
  employees_unchanged: sha256:53736acfd6d6c42c27041d7f28bd84722efd96e8228f8c424c1d43547ac30a24
  tara_deepgram_unchanged: sha256:ee371b7bb007742f60ead7ab2db96c547b8014808ca8a901d94465527866469b
  byod_broker_unchanged: sha256:ae0fe36a8468690f7c0da07a1af5ae608d069fd3f8b8e1d4d2b6088706340eee
  playwright_unchanged: sha256:4177c43a4414d50b0028a957c85bce332201fc5a1c72fbbbc65179dd5144ee94
  frontend_single: sha256:fcbf0022382f9a04656f69660f4f92fb6760d40efff9468188e23749bcf7cd0a
migrations: []
changes:
  - Every /api/chat surface now defaults structured intent planning to google/gemini-2.5-flash-lite.
  - User-facing direct, grounded, and connector-action synthesis defaults to cerebras/gpt-oss-120b.
  - The Cerebras default is pinned through OpenRouter to provider only cerebras with provider fallback disabled and data collection denied.
  - Legacy frontend values gpt-oss-120b and openai/gpt-oss-120b resolve to the Cerebras default without a frontend rebuild.
  - Direct synthesis is bounded to the planner draft so it cannot introduce unrelated claims.
acceptance:
  production_image_tests: 21/21
  provider_smoke:
    planner: google/gemini-2.5-flash-lite via Google
    planner_ms: 492
    synthesis: openai/gpt-oss-120b via Cerebras
  authenticated_direct_chat:
    status: 200
    legacy_model_value: gpt-oss-120b
    response: Hello!
    planner: google/gemini-2.5-flash-lite
    synthesis: cerebras/gpt-oss-120b
    total_ms: 2165
  authenticated_scoped_chat:
    project: 66275318-c11c-4dcb-b6a9-457b43c3bfda
    status: 200
    query: What do you know about SolvisPia?
    source_count: 2
    grounded: true
    confidence: 0.97
    planner: google/gemini-2.5-flash-lite
    synthesis: cerebras/gpt-oss-120b
    total_ms: 4254
  public_200: [hivemind_home, login, overview, api_health, core_health]
  core_health: healthy
  unchanged_tara_container_health: healthy
  fresh_fatal_errors: 0
residual_risks:
  - The external tara.singulancelabs.com health request hit a pre-existing TLS handshake error; the unchanged tara-deepgram container remained healthy.
  - Explicit non-default model selections remain supported; only legacy/default 120B values are remapped to Cerebras.
untested_side_effects:
  - No customer writes, connector actions, or memory mutations were performed.
rollback:
  core: hivemind/core-api:rollback-20260720T190352Z
  frontend_unchanged: hivemind/fe:prod-20260719-c98a7427-single
  env_backup: /root/hivemind/.env.bak-prod-20260720-9937c452
```
