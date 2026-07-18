# Current SINGULANCE Production Release

This file is the deployment ledger. Update it only after production acceptance succeeds.

```yaml
release_id: prod-20260718-53f9e577
host: singulance
deployed_at_utc: 2026-07-18T12:47:07Z
parent:
  branch: singulance-main
  sha: 53f9e57738f94cfcb67f353138c5a68cdaeeafb5
frontend:
  sha: 1d936b0c7590a6938124f6d6ce44f98c41ad87a1
runtime:
  VERSION: prod-20260718-53f9e577
  NEXT_VERSION: prod-20260718-53f9e577
images:
  core: sha256:fa3403aeb3cc1b8a98ca97f4a2d68b1a2030d390c31c14bcdabe8fb6bb40d771
  control: sha256:6746cff350aaa3f418da3e9dc8aa34a430c008d94375b1b93120d448581aaa24
  employees: sha256:c3e171ae8ba9086442f4dd66bb6c9213d1d6033937f96a4d6a180db15eb805a7
  tara_deepgram: sha256:ee371b7bb007742f60ead7ab2db96c547b8014808ca8a901d94465527866469b
  frontend_single: sha256:a3947a69b2381e99e07e918ba9b653ecb18bdc2498ed1e2f2ae0a61614286894
changes:
  - Reconciled multilingual Gemini Meeting Notes STT into canonical Core.
  - Rebuilt TARA from canonical browser, telephony, campaign, live-listen, and dial-auth sources.
  - TARA call history, insights, leads, usage, and goal rate refresh automatically after call end.
  - Existing post-call analysis remains one server-owned pipeline for browser, telephony, and campaign calls.
acceptance:
  public: [tara_page, api_health, core_health, tara_health, postcall_refresh_bundle]
  runtime: [tara_source_hashes, unauthorized_dial_401, latest_call_analyzed]
  call_data: {completed: 9, insights: 8, turns: 42, latest_completed_analyzed: true}
  fresh_fatal_errors: 0
meeting_tara_commit_audit:
  recorder_durability: present
  multilingual_stt: present
  meeting_intelligence: present
  call_end_insights_and_leads: present
  tara_memory: present
  live_listen_and_dial_auth: present
rollback:
  tara_deepgram: hivemind/tara-deepgram:rollback-20260718T124040Z
  frontend_single: hivemind/fe:rollback-20260718T124040Z-single
```

No customer email, connector action, or telephone call was triggered during release acceptance.
