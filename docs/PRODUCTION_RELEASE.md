# Current SINGULANCE Production Release

This file is the deployment ledger. Update it only after production acceptance succeeds.

```yaml
release_id: prod-20260720-b3ca804a
host: singulance
deployed_at_utc: 2026-07-20T08:56:41Z
parent:
  branch: singulance-main
  sha: b3ca804a111957f1ea47c9c07373af6f2cbed07b
frontend:
  sha: 1702fa72952c2ae74dae7a7b47950737417e1863
runtime:
  VERSION: prod-20260720-b3ca804a
  NEXT_VERSION: prod-20260720-b3ca804a
images:
  core: sha256:396dda0757ae61af6448db1f8c2a6cfa38b54b0c3ed60d3c21d077d2befbfffc
  control: sha256:830031290c1b4bc60fc95cf607fb08352b53e25e6f49d319f7a5f438e90639e4
  employees: sha256:237d7346d9239f7677517010d81bf244d95f0812a260a285bacc732815690c29
  tara_deepgram: sha256:cf7c25e26e872010b4f443b30dcfbedfb4b52cb100c42e70c25c842f41010876
  frontend_single: sha256:0ba7d5378c37e9269339903d89115abaa90220a9825f2096d8c90739f42dcfd4
changes:
  - Released canonical source-grounded recall/chat updates through b3ca804a.
  - Rebuilt Core, Control, Employees, TARA, and the vNext frontend from one clean parent commit.
  - Reconciled both frontend routes to the vNext release: `hivemind-next-frontend-1` for next/personal/enterprise and `hm-fe` for the root domain.
  - Retained stable aliases and immediate timestamped rollback references; pruned obsolete application image tags only.
acceptance:
  public: [homepage_200, hivemind_landing_200, api_health_200, core_health_200]
  authenticated:
    - direct_recall_200
    - direct_chat_200_grounded_with_citations
  runtime: [core_healthy, control_healthy, employees_healthy, tara_healthy, frontend_running]
  release_marker: allowImplicitSource_equals_not_recallPlan_source_requested
  fresh_fatal_errors: 0
  notes:
    - Recall fact-mode test reached its latency budget with no returned facts; grounded chat remained successful with citations.
rollback:
  core: hivemind/core-api:stable
  control: hivemind/control-plane:stable
  employees: hivemind/employees:stable
  tara_deepgram: hivemind/tara-deepgram:stable
  frontend_single: hivemind/fe:stable-single
  immediate_timestamped: 20260720T085005Z
```

No customer email, connector action, telephone call, or write operation was triggered during release acceptance.
