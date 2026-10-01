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

- Autonomous backend release succeeded: Core and Control healthy on 9c62c84b; manifest /root/releases/manifests/9c62c84b/20261001T220750Z/RELEASE_MANIFEST.json.
- Read-only production subscription check confirmed active Gmail incoming-message subscription after opening the new-session page; no app event content was read by this check.
- Frontend dd4d8fbe adds refresh replay for unchanged generated text, preserving edited user drafts, and explicit suggestion clicks replace composer drafts without sending.
- Final frontend release version: a3ed3e3b-8ac9-4f0f-b530-338cf3b6111f, exact source dd4d8fbe. Live browser verified click-to-replace using an existing generated draft; no message submitted. Setup section absent.

## Completed account-wide activity coverage

Backend ff3f5312 selects verified account-wide provider types for Gmail incoming messages, Slack messages, GitHub assigned issues and new pull requests, Drive file updates, and Docs document updates. All configuration comes from the exact live schema defaults; no guessed channel/repository IDs. Each account/event failure is isolated and pending subscriptions can retry on the bounded reconciliation cadence. Explicit paused/deleted subscriptions are preserved. Tool metadata retains provider versions; Drive updates resolve a file name using only the exact-account read-only metadata tool and partial fields, with schema validation and version pinning. Slack numeric timestamps and app update timestamps are normalized; repeated topics retain their newest event. Unknown apps with no supported event type are not represented as covered.

Provider metadata verified live: Slack message version 20260929_00, GitHub assigned issue 20260924_00, Drive update and metadata tool 20261001_00, Docs update 20260826_00. No user message/document body was fetched for this metadata verification.
- Coverage release succeeded: Core/Control healthy and exact ff3f5312 revision verified; manifest /root/releases/manifests/ff3f5312/20261001T223551Z/RELEASE_MANIFEST.json. Public ingress check returned 200 ignored for a correctly signed non-user health payload and 401 for invalid signature. No artificial user event was inserted. Prior backend source for rollback: 9c62c84b.
- Authenticated live UI now confirms a real Gmail event dated Oct 2 appears as the leading editable query, alongside one memory dated Oct 2 and one Flashback dated Oct 1. No configuration section and no chat message submission. Screenshot: /tmp/hivemind-live-connected-suggestions.png. This supersedes the earlier limitation that no real event delivery had been observed.

## JEV company relevance gate

Final backend source 523b99e7 adds typed JEV eligibility decisions before events become composer suggestions. Bounded context consists of the authenticated organization profile and the caller's recent memory titles/tags; no full memory history. Five choices: useful company work, promotional noise, unrelated, sensitive, uncertain. Approval requires useful-company-work probability >=0.75 and margin >=0.2. Industry resemblance alone is insufficient. Automated senders are classified in context, not blanket-rejected.

Decisions and policy version are durable per event. Suggestions query only approved receipts from the current policy. Existing unclassified events are hidden pending evaluation; an unavailable classifier never defaults to showing them. Background batches use durable leases, recover interrupted work, retry unavailable decisions after a bounded interval, and preserve tenant/account authorization. Context is compact and cached; page refresh does not reclassify decided events. Spam/trash and credential/authentication content are suppressed by rules. Additive event-store columns are initialized through the existing durable store boundary. Harness/frontend unchanged.
