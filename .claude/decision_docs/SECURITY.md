# Security Decision

Tenant isolation, authorization, and provenance are cross-cutting invariants,
not middleware assumptions.

- Derive identity/org from authenticated server state.
- Apply authorized project/team/member scope to relational, vector, graph,
  connector, audit, usage, and storage operations.
- Enforce role and quota before expensive work or external effects.
- Treat browser input, connector payloads, documents, URLs, and BYOD endpoints
  as untrusted.
- Keep audit trails append-only; redact secrets and sensitive payloads.
- Require approval and idempotency for external writes.
- Additive migrations, backups, and restore evidence are mandatory for
  production data changes.

Read `SINGULANCE-ONBOARD/SECURITY.md` and `Security-hardening-journal.md` before
security-sensitive work. Test cross-tenant/project denial, not only happy paths.
