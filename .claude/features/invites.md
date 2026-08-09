# Invitations

Status: released 2026-08-02

Invitation creation accepts an idempotency key and uses the existing transactional
seat reservation and acceptance path. Concurrent duplicate creates refetch the
same organization-scoped invitation rather than sending or reserving twice.
Invite lifecycle notifications are scoped to the recipient and organization;
external invitees continue to receive invitation email through the existing
delivery path.

The focused test suite verifies the canonical authorization contract. A live
invite race and email-delivery browser acceptance remain operational canaries.

## B2C And B2B Access Queue

Released on 2026-08-09 from `d150a20bb0cf20074660fb3edc92aa094155f5ee`
and retained by subsequent canonical descendants.

- The public Singulance waitlist now writes idempotent, pre-organization access
  applications into the `hivemind` schema instead of the former Notion relay.
- Platform Admin exposes separate B2C waitlist and B2B request queues. Approval
  never sends immediately: B2B first receives managed/self-hosted configuration,
  then both paths render the exact server-owned email before the operator sends.
- Personal invitations reuse signed personal Check-in admission. Enterprise
  invitations reuse the existing one-owner invitation service, immutable
  onboarding entitlement, one-time recovery code, and Check-in route.
- Live acceptance: homepage-origin preflight returned 204 with the exact origin;
  personal and enterprise intake returned 202; approve and preview returned 200;
  both controlled canaries reached `invited`; Cloudflare accepted both deliveries.
- Signed-in Playwright passed the Admin B2C/B2B queues and the dedicated personal
  `Check in to your workspace` page. The deployed frontend contained both queue
  and Check-in bundle markers.
