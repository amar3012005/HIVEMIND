# HIVEMIND Triggers release

- Backend source: e51611a7646445e014a0080107aad4d8996d2223.
- Frontend source: e445cbd6185c6e5e2eabff79892cca5d2a10897d.
- Worker version: 16ef3199-695e-4a02-bccc-70afb1908e8d.
- Canonical Core/Control release succeeded, both healthy, revisions verified e51611a76464. Manifest: /root/releases/manifests/e51611a7/20261001T215746Z/RELEASE_MANIFEST.json.
- Guarded migration path used; initial skip-migrations attempt stopped before cutover.
- Harness runner ec8f868f79 and Employees untouched. Production Control task-memory capability preserved.
- Authenticated browser proof: real composer contains editable unsent contextual query, three source/date-labelled suggestions; Connected activity discovers Gmail events and inspect renders provider defaults (interval 2, labelIds INBOX) with exact company account. No subscription activated during verification.
- Project V3 webhook registered, signing secret retained only in managed production environment. Signed ingestion validates tenant/account, provider schema and duplicate delivery identity.
- Toolkit operations: discover, inspect, create, list, pause, resume, delete, deliveries, suggestions. Hosted MCP and agent tool registry share the schema. No native Harness profile changes.
- Suggestions use deterministic templates, saved memories, Flashbacks and permitted stored events. No model calls for preparing suggestions; no automatic chat submission or agent dispatch.
- Actual user-event delivery remains dependent on explicit subscription activation. No real app event claimed as received in this release.
- Rollback Worker: 952bcf62-dce3-42c1-ac31-dace5fea5bf1. Previous Core digest sha256:f0737613f43b9d771c95094a8ad48b5c4503bc215a8db0f40ebc9cd76b60e141; previous Control digest sha256:2f6d75a6a85773ccb72469aac22a9a6193fc11e7743db9f4efad405224182aaa.

## Autonomous follow-up

User clarified that event provisioning must be automatic, without a configuration section. Backend 9c62c84b reconciles supported read event subscriptions from connected accounts, uses provider schema defaults only, preserves paused/deleted opt-outs, and reuses provider upsert identity. Reconciliation is background and throttled per authenticated user; suggestions still read stored events. Frontend 49a009b2 removes setup controls from the composer and retains the three contextual query rows. Apps requiring a channel/repository or custom webhook setup are not guessed or claimed covered. Native Harness unchanged.
