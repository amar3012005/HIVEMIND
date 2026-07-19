# Current SINGULANCE Production Release

This file is the deployment ledger. Update it only after production acceptance succeeds.

```yaml
release_id: prod-20260719-0f62f221
host: singulance
deployed_at_utc: 2026-07-19T17:34:24Z
parent:
  branch: singulance-main
  sha: 0f62f2212e95e590469e6207d9a3cc1287e56ef6
frontend:
  declared_gitlink_sha: 1702fa72952c2ae74dae7a7b47950737417e1863
  recreated: false
runtime:
  VERSION: prod-20260719-0f62f221
  NEXT_VERSION: prod-20260719-0f62f221
images:
  core: sha256:44ac6d966e3f568b6c046c785d908f326ac2e6ecfb05bbd066d33d1b77bdcd96
  control_unchanged: sha256:edfedbab3f5938d0ad218fb93bfb08f15b8fc36b909c4f2292fc4413ae646172
  employees_unchanged: sha256:53736acfd6d6c42c27041d7f28bd84722efd96e8228f8c424c1d43547ac30a24
  tara_deepgram_unchanged: sha256:ee371b7bb007742f60ead7ab2db96c547b8014808ca8a901d94465527866469b
  byod_broker_unchanged: sha256:ae0fe36a8468690f7c0da07a1af5ae608d069fd3f8b8e1d4d2b6088706340eee
  playwright_unchanged: sha256:4177c43a4414d50b0028a957c85bce332201fc5a1c72fbbbc65179dd5144ee94
  frontend_single_unchanged: sha256:41eb07c1de48f0f371e533f327cdba5e9c0efbfa999d19da15e825401c121637
migrations: []
changes:
  - Image OCR now makes one bounded vision call for detailed plain-text visual evidence.
  - Vision no longer generates JSON schemas, durable facts, entities, or relationships.
  - Image evidence is forced through canonical document ingestion for promotion, canonical entities, typed relationships, evidence links, embeddings, provenance, and tenant routing.
acceptance:
  production_image_tests: 8/8
  real_provider_smoke:
    provider: openrouter
    model: google/gemini-2.5-flash-lite
    calls: 1
    plain_text_chars: 485
    vision_entities: 0
    evidence_role: raw_visual_description
  route_auth: 401_without_api_key
  public_200: [hivemind_home, login, overview, api_health, core_health]
  core_health: healthy
  served_markers: [detailed_plain_text_prompt, canonical_image_document_handoff]
  fresh_fatal_errors: 0
untested_side_effects:
  - No customer image was persisted during acceptance; the provider smoke intentionally bypassed persistence.
rollback:
  core: hivemind/core-api:rollback-20260719T173424Z
  env_backup: /root/hivemind/.env.bak-prod-20260719-0f62f221
```
