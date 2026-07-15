# Current SINGULANCE Production Release

This file is the deployment ledger. Update it only after production acceptance succeeds.

```yaml
release_id: prod-20260715-19fa016d
host: singulance
deployed_at_utc: 2026-07-15T18:15:00Z
parent:
  branch: hivemind-main (PR #13 squash-merge, admin bypass authorized by owner; enforce_admins re-enabled)
  sha: 19fa016d639c2cbc80d155b908b1856377147549
frontend:
  gitlink: a017b4322aba68b41fca477af7347239a58122bf (unchanged by this release)
runtime:
  VERSION: prod-20260715-19fa016d
  NEXT_VERSION: prod-20260715-8aa07a4b (vNext canary intentionally not advanced)
images:
  core: sha256:0985b38bc9222dee0212fb87f85ccef6d9246d2bb3a759e4273d1ac78544b2a0
  others: unchanged from prior release (core-only change)
migrations:
  - 20260710153000_agent_usage_quotas (additive ADD COLUMN IF NOT EXISTS; applied 2026-07-15T18:14Z
    AFTER first promotion surfaced taraSeconds errors — order deviation from invariant 9, recorded;
    pre-existing encrypted PG backup hivemind-20260715-033001.sql.gz.enc (16.3MB) predates the change)
acceptance:
  scope: PR13 recall source-grounding (44/44 contract tests in prod image pre-merge)
  behavior:
    - source-explain agent path: fail-closed on unknown source (0 sections)
    - chat FOREST scenario warm: grounded brochure answer, 9 sources, 4.8s (stable: same question refused w/ 3 sources — pre-existing claim-validator gate, not this release)
    - fact fast path 28ms
  public: [homepage 200, core_health 200, control loopback 200]
  containers: [hm-core healthy on release tag, hm-control, hm-employees, tara-deepgram healthy]
  fresh_fatal_errors: 0
rollback:
  image: hivemind/core-api:prod-20260715-8aa07a4b (env backup /root/hivemind/.env.bak-recall-p1)
notes:
  - ledger was one release stale before this entry (box ran prod-20260715-8aa07a4b, ledger showed prod-20260714-8f049395)
  - tara-aaas container no longer present (superseded by tara-deepgram; predates this release)
  - stable + latest aliases advanced to this release post-acceptance
```

## Previous release

```yaml
release_id: prod-20260714-8f049395
host: singulance
deployed_at_utc: 2026-07-14T09:45:00Z
parent:
  branch: feature-loop/outbound-closed-loop
  sha: 8f049395c2284d4c2393265134e746cee39f1854
frontend:
  branch: feature-loop/mobile-app-v2
  sha: 73c65178901bf6e24cc13e366209b473fe738abf
runtime:
  VERSION: prod-20260714-8f049395
  NEXT_VERSION: prod-20260714-8f049395
images:
  core: sha256:bb54067c4e8e846492db5b11960f2253858400dc76b68ade484960366c702fde
  control: sha256:d1e75c6700a92577f355c7e8702a7cf60282a08d573917d07c4ab62312f172d2
  employees: sha256:4adc05846b783200c906432b59b1c749490707091907113e94908e4ad04372bc
  tara_deepgram: sha256:f7e92ff68a9bec67aa508223a8a7f3a79df995a34ebc2c75656a9a3c9b4a8288
  frontend_single: sha256:b1d29c43b6ad5d7f6603ec75e3a9028b4fb5634d7b0457103402b4db2c524307
acceptance:
  authenticated: [bootstrap, teams, org_projects, hyper_outcomes]
  public: [homepage, login, overview, api_health, core_health, tara_health]
  fresh_fatal_errors: 0
rollback:
  timestamp: 20260714T094030Z
```

No live customer email or telephone call was triggered during this release acceptance.

