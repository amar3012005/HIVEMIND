# Platform email deliverability audit — 9 October 2026

## Observed deployment

Read-only Docker configuration inspection, public DNS resolution and Cloudflare limits API were used. No email was sent; no DNS, suppression entry, provider setting or container was changed.

- Core: `hivemind/core-api:sha-ad0ed9b9a`.
- Control: `hivemind/control-plane:sha-5b7f0780`.
- Canonical system sender: Cloudflare Email Sending REST. Account/token present in both services; Gmail-over-Nango system fallback absent.
- Managed environment contains legacy `Singulance <welcome@admin.singulancelabs.com>`. Current source maps it to `Amar at SINGULANCE <amar@admin.singulancelabs.com>`. This is the effective canonical source identity, not proof of the visible From header of every historical message.
- Account quota API: 1,000/day, 7 sent, `over_quota=false` at inspection.
- Legacy Core meeting/organization invite handlers still import `services/email-sender.js`, which selects Resend then SMTP. Neither provider is configured in live Core/Control. Those paths cannot be assumed to deliver through Cloudflare. A meeting-invite handler increments `sent` without examining `sendEmail().ok`; this is a separate receipt correctness defect requiring a focused follow-up.

## Authentication evidence

For the actual sending subdomain `admin.singulancelabs.com`:

| Record | Public resolver observation |
| --- | --- |
| `cf-bounce.admin.singulancelabs.com` TXT | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| `cf-bounce._domainkey.admin.singulancelabs.com` TXT | DKIM1 RSA key present, 420 characters |
| `cf-bounce.admin.singulancelabs.com` MX | Cloudflare route1/route2/route3 servers |
| `_dmarc.admin.singulancelabs.com` TXT | `v=DMARC1; p=reject;` |
| `_dmarc.singulancelabs.com` TXT | `p=none; rua=mailto:support@singulancelabs.com` |

Absence of a TXT record directly on `admin.singulancelabs.com` is not a missing Sending SPF: Sending uses the `cf-bounce` envelope domain. Do not add a second SPF record or copy Routing records into Sending.

These records establish publication, not actual per-message SPF/DKIM/DMARC pass. Confirm Authentication-Results on a real existing recipient message and the domain's Email Sending settings. The guessed account-domain listing API returned 404 and was not used as verification.

## Source correction prepared

`sendWithCloudflare()` now marks a non-transient HTTP rejection as terminal for this send. Both canonical template and rendered-message dispatchers already stop fallback when `permanent` is set. Consequently a recipient suppression rejection cannot bypass Cloudflare through a future configured Gmail fallback. This flag describes the attempt: it does not mean a temporary suppression should be deleted or its expiry ignored. Existing successful receipt projection, Runtime idempotency and transient retry/fallback contracts are unchanged.

This change is source only and undeployed. `node --check core/src/email/email-service.js` and `git diff --check` pass. No tests were run or added for this delegated request. Static review confirms both dispatcher boundaries inspect `permanent` before invoking Gmail; provider acceptance, receipt projection and Runtime request deduplication were not modified.

## Content and separation

- Canonical templates carry HTML and plaintext; the sign-in code message is focused on authentication and its expiry, without upgrade promotions.
- Current account and Runtime messages share `admin.singulancelabs.com`; there is no confirmed independently onboarded marketing sender.
- The generic `announcement` template and `/v1/notifications/broadcast` route can emit arbitrary content through the transactional transport. There is no evident marketing unsubscribe/opt-in enforcement in that route. Do not use it for marketing campaigns until a dedicated marketing provider, consent records and working one-click unsubscribe are implemented.
- Important boundary finding: the broadcast route requires an organization admin but selects all platform users. Scope the recipient query to the caller's organization or require actual platform administrator authority before enabling any broadcast. Do not send a broadcast to verify this.
- Current receipt ledger is useful for send acceptance; it is not proof of inbox placement or complete delayed delivery/complaint monitoring.

## Operator actions

1. Keep the already authenticated `admin` Sending domain for account mail. Changing to `notify` is optional, not an immediate deliverability fix; onboard/verify its exact Cloudflare-managed records before changing the managed From identity.
2. If campaigns are needed, use a separate marketing provider and `news.singulancelabs.com`, authenticated with that provider's exact records. Do not repurpose Cloudflare's transactional sender for campaigns.
3. In Cloudflare Email Sending settings confirm current domain readiness and suppression behavior. Monitor aggregate delivery failures, hard bounces and complaints; do not remove provider suppressions merely to retry mail.
4. Confirm Google Postmaster Tools ownership for the actual sending domain and inspect available reputation/authentication data. Account setup and useful volume-dependent metrics are not verified by this audit.
5. Consider a monitored DMARC reporting address for the `admin` domain, with mailbox ownership/processing confirmed before adding `rua`. Do not weaken its existing `p=reject` policy blindly.
6. After focused regression checks and an authorized scoped Control/Core release, verify a controlled message's raw headers and delivery receipt. Gmail Primary placement cannot be guaranteed; Promotions/Updates classification is separate from spam.

## Exact follow-up boundaries

1. **Cross-organization broadcast:** `core/src/control-plane-server.js:6025` handles POST `/v1/notifications/broadcast`; line 6028 authorizes via `requireOrgAdmin`, while lines 6035–6037 query `prisma.user.findMany` with email-only filters. `requireOrgAdmin` begins at line 2540 and accepts organization membership authority, not a platform administrator decision. Even the default dry run returns recipient counts and a sample from this globally selected set. Narrow fix: require a nonempty authenticated session org and add `organizations: { some: { orgId: current.session.orgId, isActive: true } }` to the User query (the relation is `User.organizations`, schema line 36). Scope live sends and dry-run samples identically. If platform-wide announcements are an intentional separate operation, require the existing actual platform-administrator boundary in a separately named endpoint; do not retain organization-admin authority for it. Verify a two-organization case and missing/denied session before deployment.
2. **False meeting delivery count:** `core/src/server.js:8072` calls `await sendEmail(...)` and unconditionally increments `sent`. The sender explicitly returns `{ ok: false, reason: 'disabled' }` when Resend/SMTP are absent (`core/src/services/email-sender.js`), so no exception reaches the handler's catch. Narrow fix: retain the returned receipt; increment accepted count only for `receipt.ok === true`, expose failed/disabled counts separately without recipient or provider-secret leakage. Do not describe transport acceptance as inbox delivery. Reuse canonical Cloudflare `sendRenderedSystemEmail` if migrating this route, including HTML escaping of user-controlled names/title, rather than configuring a second provider just to conceal the result handling bug.
3. **Legacy invite provider split:** `core/src/server.js:12906` (resend) and `:19679` (new invite) import the Resend/SMTP sender. Unlike the meeting count, their dispatch receipt handling should be retained when connecting the canonical transport. Change only the shared transport seam, preserve generated invite URL, org/project/team authorization and dispatch receipt fields, and verify failure as well as success. This audit does not claim those invite handlers fabricate success.
4. **Marketing dispatch:** broadcast's arbitrary subject/body and `announcement` template are not an approved marketing stream. Separate account notices from campaigns by intended purpose, not by a subject-line keyword heuristic. Add verified opt-in and working one-click unsubscribe on a dedicated marketing transport before using campaigns; no unsubscribe header should point to an unimplemented endpoint.

## Primary documentation consulted

- [Cloudflare domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/)
- [Cloudflare authentication](https://developers.cloudflare.com/email-service/concepts/email-authentication/)
- [Cloudflare deliverability](https://developers.cloudflare.com/email-service/concepts/deliverability/)
- [Cloudflare suppression enforcement](https://developers.cloudflare.com/email-service/concepts/suppressions/)

Public DNS and quota observations are a point-in-time check, not a reputation or inbox-placement guarantee.

## Follow-up implementation — 9 October 2026

The prepared follow-up now addresses the three concrete delivery boundaries:

- Broadcast requires an authenticated organization and filters recipients by `User.organizations.some` with that organization and `isActive: true`; the same query feeds dry-run count/sample and actual dispatch. No platform-wide recipient selection remains in this route.
- Meeting notices count successful transport acceptance separately from rejected/thrown attempts. The response retains `sent`, adds `failed` and `delivery_status`, and sets `ok=false` when any attempt fails. Names, titles and organization strings are escaped in HTML; failure logging avoids raw recipient/error data.
- Legacy `services/email-sender.js` now delegates to canonical `sendRenderedSystemEmail`, retaining `ok`, provider receipts and compatibility `id`/`reason` fields. Invitation URL generation and scope checks remain in the existing Core handlers. Invitation HTML escapes organization, inviter, role, project/team names and URL attributes while preserving original subject/plaintext values. Resend `lastSentAt` and `sendCount` advance only on accepted dispatch; extending the invite expiry remains independent of mail acceptance.

Verification: all three changed JavaScript files pass `node --check`; `git diff --check` passes. Twenty isolated tests pass in the existing immutable Core image with source/tests mounted read-only and `--network none`: eight new boundary checks plus twelve existing system-email provider checks. The new route checks execute the extracted actual handler code against in-memory organization/provider dependencies; this verifies query construction, dry-run/live separation, missing/denied organization authority and acceptance counting, **not** PostgreSQL row isolation or live authenticated HTTP behavior. Provider tests use fake addresses and mocked fetch; no network mail occurred.

No Runtime notification idempotency code, schemas, provider settings, DNS or live service was modified. No release has occurred. Proposed rollout: review and push the exact source SHA, then use the canonical scoped release path for **Control Plane and Core** (broadcast is Control-owned; legacy invite/meeting handlers are Core-owned), retaining each old image for rollback. Before release, add two-organization authenticated/database verification; after authorized release, check scoped API responses and a separately authorized controlled mail receipt. Existing Gmail category/reputation and marketing-provider operator actions remain.

### Compatibility review and release instructions

A follow-up restores the legacy wrapper's bounded, never-throws contract even if unexpected rendering/configuration code throws; the receipt returns `email_dispatch_failed` without exception details. Rendered dispatch now uses the same sender header safety check as named-template dispatch; valid explicit From overrides still pass through unchanged, while CR/LF injection is rejected before fetch. Compatibility `id` aliases `messageId`; failed `reason` aliases the canonical error; existing `ok`, provider and delivery status are retained. No Resend/SMTP credential fallback remains in the legacy wrapper by design: this closes the deployed unconfigured transport split, rather than adding a second sender.

The focused suite now has **22 passing tests**, including safe explicit sender override, malformed From rejection and unexpected rendering failure. This remains isolated mock-provider evidence, not live delivery or database isolation.

Root owns promotion and deployment. After review/cherry-pick and normal push to the canonical branch, use the exact promoted SHA (not this unmerged task SHA):

```bash
# Set this to the full SHA confirmed on github/singulance-main after promotion.
EMAIL_RELEASE_SHA=<full-promoted-sha>
RELEASE_SESSION_ID=email-correctness-dryrun-20261009 scripts/release-canonical.sh \
  --sha "$EMAIL_RELEASE_SHA" --services core,control-plane \
  --service-scoped --skip-migrations --dry-run
RELEASE_SESSION_ID=email-correctness-20261009 scripts/release-canonical.sh \
  --sha "$EMAIL_RELEASE_SHA" --services core,control-plane \
  --service-scoped --skip-migrations \
  --canary-url https://api.singulancelabs.com/health
```

Run these from the clean promoted parent worktree. The helper resolves canonical GitHub if `origin` is local, creates immutable source/images and preserves managed `/root/hivemind/.env`; it invokes `preserve-crm-activation.py` rather than discarding Control's live `crm-activation.json`. No migration is introduced here. Confirm current source/metadata immediately before running. Recorded prior image identities for rollback: Core `hivemind/core-api:sha-ad0ed9b9a`, Control `hivemind/control-plane:sha-5b7f0780`. The helper records exact image IDs and rollback names in its release manifest; retain that manifest and verify unchanged sibling services after cutover. Do not restart Harness for this release.

The public health canary is necessary but insufficient: add authenticated org-A dry-run verification excluding org-B/inactive users, denied ordinary-member verification, and existing receipt API checks. Do not invoke a live broadcast or invitation just to obtain a success result without explicit mail-test authorization.

**Opt-in risk remains:** organization scoping fixes recipient authorization, not campaign consent. The generic announcement path still lacks dedicated marketing opt-in/unsubscribe enforcement and can carry arbitrary copy. Use only expected transactional organization notices; marketing activation requires the separate consent/unsubscribe/transport work described above. This release does not claim complete marketing readiness or inbox-category control.

### Read-only real database verification before cutover

The actual deployed Prisma client rejected the inherited baseline `email: { not: null }` condition because `User.email` is required/nonnullable. The broadcast query now removes that redundant filter; email validity remains checked by the canonical transport, and local placeholder exclusions plus organization scope remain.

The corrected exact scoped Prisma query ran successfully inside `SET TRANSACTION READ ONLY` against 12 existing organizations, selecting only their active memberships and yielding zero out-of-organization selected users. No dummy-named organizations or inactive memberships exist in this database snapshot, so a real inactive-membership fixture was unavailable; the isolated handler check exercises inactive exclusion. No rows were written and no recipient addresses, user IDs or organization names were logged. Aggregate evidence: `/root/releases/email-recipient-readonly-20261009.json`; reproducible read-only script: `/root/releases/email-recipient-readonly-20261009.mjs` (connection credential passed privately through stdin, never recorded).

Authenticated public broadcast canary mechanism: `getCurrentSession` accepts a verified `hm_cp_session` cookie or an existing CP session ID in a Bearer header, then loads the session store; `requireOrgAdmin` checks active organization authority. Internal signed Harness JWTs used by other release canaries do not satisfy that public session contract. No approved existing test CP session was identified in this task; obtaining one by normal authenticated browser/login is the remaining canary prerequisite. The canary must POST `dryRun:true` and must not use a live broadcast or create a mail job.
