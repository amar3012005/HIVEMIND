# Administrator account erasure

The authenticated platform-admin API adds GET/POST `/admin/api/platform/users/:id/erasure`. Preview uses the real UUID, account email, owned-record counts and read-only ownership planning. Mutation requires the exact email and DELETE intent. No sign-in impersonation is used: the existing durable ledger records a distinct signed platform-admin session identity plus a hash of the confirmed email. The worker refuses a changed email, preserves all existing shared/source/vector checks, and resumes through the existing fenced erasure worker. No second deletion engine or database migration.

The All users dialog displays scope and retention, requires typing the email, and tracks pending/blocked/completed receipts. A queued or blocked operation is not presented as deleted. Unknown request outcomes are reconciled with GET rather than blindly repeating deletion.

The existing service erases supported account-owned active records, memories, reconciled source objects and vectors before identity finalization. Shared organizational records, remote/BYOD sources and unknown store ownership can block completion. Audit receipts/backups retain their existing policy, and external provider originals are not deleted. This change does not establish universal provider-side credential revocation or an independently audited purge of every native runtime store; those coverage limits must remain explicit.

- [x] Code: admin authorization, exact email, distinct actor, existing erasure scope/recovery, denial and changed-email cases.
- [ ] Control deployed: immutable source/image, complete prior environment preserved, attention URL retained, siblings unchanged.
- [ ] Frontend deployed: exact source and rollback version.
- [ ] Live verified: preview, denial paths and dialog on real admin session.
- [ ] Disposable fixture erasure: only a newly created test identity and its own memory; never a real user.
- [ ] Universal all-store/provider credential purge coverage (not claimed by this adapter).
