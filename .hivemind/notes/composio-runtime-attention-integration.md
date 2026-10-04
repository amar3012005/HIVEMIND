# Composio Runtime attention integration

Existing owner: HIVEMIND-triggers at c922c551, existing signed receiver /v1/hivemind/triggers/webhook and Jev classifier. Both receiver files and route are verified present in live hm-control; exact live source SHA was not verified.

Core changes extend that receiver/classifier with explicit future-event subscription opt-in, bounded native context, retain/notify/wake assessment and admission receipt reconciliation. Retain and wake are excluded from the suggestions list; notify uses the existing suggestions list. Default subscriptions retain original suggestions-only behavior. No second receiver, scheduler or registry.

Native companion: Harness-runtime-attention, packages/hivemind/hq-runtime/src/attention.ts. Disabled-default authenticated POST /internal/hivemind/runtime-attention resolves canonical owner Runtime via current membership, subscription consent and harness_company_hq. Context reads do not activate agents. Delivery verifies saved decision and current snapshot epoch, admits through native next-turn wake, flushes, and reconciles the exact event ID. Accepted means durable admission, not finished work.

Auth reuses HIVE_HARNESS_RUNNER_SERVICE_SECRET, already present in live Core and runner. Purpose-separated HS256 JWT issuer hivemind-control-plane, audience hivemind-runtime-attention, 30-second expiry, exact org/user/event/operation. Raw signing key is never a bearer. No new secret required.

Release: integrate Core delta into the existing trigger owner c922c551-compatible release, not the shared checkout missing trigger files. Build and release native HQ package including ./attention export, host-webserver peer, lockfile, and web-app overlay. Enable attention plugin using existing DATABASE_URL and HIVE_HARNESS_RUNNER_SERVICE_SECRET; triggerSchema hivemind; configure bounded pool/timeouts. Set Core HIVEMIND_RUNTIME_ATTENTION_URL to runner internal authenticated seam. URL absent live at audit. Keep subscriptions off until review.

Activation: session-authenticated POST /v1/hivemind/triggers operation create with existing connected account, trigger_slug, same config and runtime_attention:true. Existing active matching subscription is upserted locally; explicit opt-in advances revision/epoch and only future events qualify. Verify exact selected subscription metadata first. Two active Gmail subscriptions exist (email sent and new message), neither was opted in by this work. Do not arbitrarily enable both. Runtime autonomy must be active to wake. No live subscription mutation performed.

Checks: Core 14 focused tests pass. Native 10 auth/admission/flush/scope tests plus one real enabled Loader/cordis.yml HTTP/disposal test pass. Full isolated native build:lib:host passes; HQ TypeScript compilation and tsdown packaging pass; packaged attention export import smoke passes; scoped oxlint and diff checks pass. Loader composition uses real WebServer and ExecutionScope, fixture-only delivery dependencies and unreachable fixture DB; it verifies mounting, unsigned rejection and disposal, not live DB admission. Live checks remaining: opted-in signed fixture through deployed receiver, quiet/notify/wake outcomes, exactly one durable admission, snapshot invalidation/retry and approved permissions. News search/polling remains separate and no subscriptions created.

## Activation correction verified live

ID-targeted profile config overrides REPLACE the row config; they do not merge it. Supply the full config in the managed profile cordis.patch.yml:

```yaml
- id: hivemind-runtime-attention
  config:
    enabled: true
    serviceSecretEnv: HIVE_HARNESS_RUNNER_SERVICE_SECRET
    connectionStringEnv: DATABASE_URL
    schema: hivemind
    triggerSchema: hivemind
    maxConnections: 4
    statementTimeoutMs: 15000
```

The existing native connected-app gateway is not a platform-trigger opt-in API. `/v1/hivemind/triggers` requires an existing owner login session; hosted MCP `hivemind_triggers` accepts existing write-capable MCP owner auth. Do not mint a new key, simulate a session, or use the shared service signing key to bypass owner login. Browser automation evaluation cannot be used to issue hidden authenticated requests. If an exposed owner UI/MCP tool is not available, an explicit owner action through the existing authenticated route is required.

## Live verification (2026-10-04)

Owner incoming-Gmail opt-in was saved true through the deployed Connectors UI; sent-email remained false. Each of three signed synthetic receiver fixtures stored exactly one event despite two submissions. Actual filtering was rules noise_or_sensitive (retain), Jev promotion_noise (.91 probability/.86 margin), and Jev uncertain (.39/.13). These are genuine rejected decisions, not a context/config fallback; no attention-level wake was approved. Do not claim Jev selected notify or wake from them.

Authenticated native context returned 200, exact owner scope, autonomy enabled, current canonical root and all three completed tasks. A signed deliver of the rejected fixture returned 409 runtime_attention_stale_or_not_admitted.

An explicitly authorized NEW test-only event (source live_transport_canary, not Jev) proved native transport independently. Exact duplicate delivery returned accepted then reused accepted, with one durable native inbox admission in the same Runtime room. The resulting turn completed; hivemind_hq_rest_state and hivemind_hq_rest both returned isError=false. The existing handoff, next-wake schedule/time and three completed tasks were preserved. The customer-acquisition-direction handoff had already superseded the older homepage-capture handoff before this test; the test did not create that direction.

Scripts: core/scripts/runtime-attention-canary.mjs uses existing signed receiver and reports actual Jev choices; core/scripts/runtime-attention-transport-canary.mjs requires explicit --authorize-test-only-native-admission and creates only a new labeled transport fixture. They use existing container auth internally, never print credentials, and require exact owner/subscription args. Synthetic receiver fixtures are in core/tests/fixtures/runtime-attention. No email is sent. Real attention-level notify/wake classification remains to verify on genuinely relevant sourced updates.
