# Current SINGULANCE Production Release

This file is the deployment ledger. Update it only after production acceptance succeeds.

```yaml
release_id: prod-20260718-5eed92fd
host: singulance
deployed_at_utc: 2026-07-17T19:27:00Z
parent:
  branch: singulance-main
  sha: 5eed92fd1909e59ee1b3eff35bf12a95ae1e13a7
frontend:
  sha: 60db1c3ee1fa9c63825a730c9e73716c69259a1b
runtime:
  VERSION: prod-20260718-5eed92fd
  NEXT_VERSION: prod-20260718-5eed92fd
images:
  core: sha256:36e1bbf40f8022bc276c86a95fb796c9dab8f3fb5408904e8cbda71e4da9f698
  control: sha256:df985f4c84c4554dc039bf5df7119776a58e7998a979c160180e40ef798fe932
  frontend_single: sha256:a348aedbf8dca9c01d1338a2663d90202791426621b1f486293129bb1aa1cec5
changes:
  - Paid personal subscriptions reconcile from Checkout, subscription, and invoice events.
  - Billing checkout returns can recover authoritative Stripe state idempotently.
  - Core plan caches invalidate immediately after subscription activation.
  - Usage and Billing no longer display the internal KB upload telemetry counter.
acceptance:
  public: [homepage, login, usage, billing, api_health, core_health, no_kb_upload_ui]
  authenticated: [muster_billing_reconcile, muster_billing_plan, muster_usage]
  muster:
    plan: pro
    subscription_status: active
    memory_storage_mode: amr_embedded
  fresh_fatal_errors: 0
backup:
  path: /root/backups/prod-20260718-df10c312.dump
  postgres_sha256: 31c0a0d3c5d05763cf1cca90bc9d5b10d50e01af98fcd74fa0e5fa37524a920b
rollback:
  core: hivemind/core-api:rollback-20260717T185728Z
  control: hivemind/control-plane:rollback-20260717T190437Z
  frontend_single: hivemind/fe:rollback-20260717T192701Z
```

No customer email, connector action, or telephone call was triggered during release acceptance.
