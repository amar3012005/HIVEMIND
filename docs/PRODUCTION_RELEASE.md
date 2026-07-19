# Current SINGULANCE Production Release

This file is the deployment ledger. Update it only after production acceptance succeeds.

```yaml
release_id: prod-20260719-b58c5589
host: singulance
deployed_at_utc: 2026-07-19T16:39:09Z
parent:
  branch: singulance-main
  sha: b58c55894578c02b5a746ae2ccd722c8b8a39c4b
frontend:
  sha: 99296bdee759bcb7678d9a71cf04c7ae9bd38031
runtime:
  VERSION: prod-20260719-b58c5589
  NEXT_VERSION: prod-20260719-b58c5589
images:
  core: sha256:cea6f2f3af92cd04c63323ed30b46fb6f3e37181193c130cf08f49d1c85ca7e9
  control: sha256:edfedbab3f5938d0ad218fb93bfb08f15b8fc36b909c4f2292fc4413ae646172
  employees: sha256:53736acfd6d6c42c27041d7f28bd84722efd96e8228f8c424c1d43547ac30a24
  tara_deepgram: sha256:ee371b7bb007742f60ead7ab2db96c547b8014808ca8a901d94465527866469b
  frontend_single: sha256:41eb07c1de48f0f371e533f327cdba5e9c0efbfa999d19da15e825401c121637
changes:
  - Replaced vision-generated extraction schemas with detailed visual evidence text.
  - Vision output now enters downstream memory promotion, entity resolution, and graph linking as raw image evidence.
acceptance:
  public: [core_health]
  runtime: [core_image_revision_b58c5589, live_visual_evidence_probe]
  visual_evidence_probe: {provider: openrouter, model: google/gemini-2.5-flash-lite, latency_ms: 3924, plain_text: true, vision_generated_entities: 0, vision_generated_facts: 0}
  fresh_fatal_errors: 0
rollback:
  core: hivemind/core-api:stable@sha256:dfb8f16126995681d6c6263f0608e601b28ca2e6ae1ba2fa2b2fb5470fae4017
```

No customer email, connector action, or telephone call was triggered during release acceptance.
