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
