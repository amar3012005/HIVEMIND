# Current SINGULANCE Production Release

This file is the deployment ledger. Update it only after production acceptance succeeds.

```yaml
release_id: prod-20260717-191051de
host: singulance
deployed_at_utc: 2026-07-17T18:21:00Z
parent:
  branch: singulance-main
  sha: 191051de4707f1c13a64652fce0d70a8784ce533
frontend:
  sha: 84ad6c49c90a2817bc8683d743d88be6a4195527
runtime:
  VERSION: prod-20260717-191051de
  NEXT_VERSION: prod-20260717-191051de
images:
  core: sha256:ee8cd3ab22d743a917b56ba02912c8e5021111767bdec237368761a7e079b68a
  control: sha256:2d0326ca1d5042cacf659a28333ae3ce39b3c7fb0f095ec2f52dd40c4ff08c4b
changes:
  - Personal managed onboarding reserves its embedded AMR route before organization creation.
  - Successful personal onboarding cannot silently fall back to hybrid storage.
  - Existing personal AMR metadata was reconciled and orphan memory-plane data was removed.
acceptance:
  public: [api_health, core_health, next_login]
  amr_canary:
    org_id: 40da0836-6e0a-4c02-82f3-3c392f155cef
    memories: 26
    relationships: 40
    warm_fact_recall_ms: [600, 465, 474]
  personal_orgs_reconciled: 4
  orphan_memory_rows_remaining: 0
  orphan_shards_remaining: 0
  fresh_fatal_errors: 0
backup:
  path: /root/backups/amr-reconcile-20260717T180646Z
  postgres_sha256: dc50e1f948139f68609e70fc26bc84a57ed4666b49555f00bc16fa2f1c4cd1fe
  amr_registry_sha256: a788bd6fc061cb98bbdc5eb1f6749aac14e692d5eb7860f54811bbf873ea815d
rollback:
  core: hivemind/core-api:rollback-20260717T180902Z
  control: hivemind/control-plane:rollback-20260717T180902Z
```

No customer email, connector action, or telephone call was triggered during release acceptance.
