# Current SINGULANCE Production Release

This file is the deployment ledger. Update it only after production acceptance succeeds.

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

