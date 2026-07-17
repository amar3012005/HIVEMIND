# Security

## Security Posture

SINGULANCE is a public B2C and enterprise B2B AI platform. Controls must hold at
every trust boundary: browser, session, API key, organization, control/core
service call, connector, document upload, BYOD transport, database, vector
store, audit record, and backup.

The authoritative phase record is
[`Security-hardening-journal.md`](../Security-hardening-journal.md). This is
the short operational summary, not a replacement for evidence.

## Verified Hardening Work

- Privileged HyperAgents and TARA access is role-gated; internal callbacks keep
  service authentication rather than user-role authorization.
- Core/control and BYOD request bodies have ceilings; malformed JSON, oversized
  requests, and parser failures are contained.
- BYOD agent/broker responses and registry handling have bounded requests, rate
  limits, safer headers, atomic writes, and container controls.
- Self-host endpoint validation blocks unsafe destinations; public endpoints
  require HTTPS and approved private Tailscale transport remains supported.
- API-key usage aggregation has the database index required by its runtime
  upsert contract.
- Audit records have an append-only database guard against update/delete.
- PostgreSQL encrypted backups and Qdrant encrypted snapshots are scheduled,
  freshness-checked, and have restore/check evidence.
- Production startup is being made fail-closed for missing/default master and
  session secrets; source fallback secrets were removed and the production
  master key was rotated.

## Open Risks And Required Follow-Through

| Priority | Work | Why it matters |
| --- | --- | --- |
| P0 | Off-host encrypted PostgreSQL/Qdrant backup delivery and restore drill | Local backups do not protect against host loss. |
| P0 | Verify limits and health checks across the active production stack | One noisy service must not exhaust the host. |
| P1 | Deploy fail-closed startup code and rotate remaining webhook, BYOD, and PQC material on schedule | Rotation is incomplete until consumers reject old credentials. |
| P1 | Tenant-isolation and auth/session regression tests across managed, `.amr`, and BYOD | Storage modes must not create a data-leak exception. |
| P1 | Upload limits, file validation, malware scanning/quarantine policy, and async queue observability | Document ingest is an expensive public attack surface. |
| P2 | BYOD signed write/audit envelopes and staged hybrid-PQC transport verification | Central PQC keys do not automatically protect the customer Box transport. |
| P2 | Centralized audit export/retention and operator alerting | Append-only local rows are not a full compliance story. |

## Security Implementation Rules

- Never trust client-provided organization IDs, roles, plans, usage, or storage
  mode without server-side resolution.
- Fail closed for authorization, quota verification, and secret configuration;
  return a retryable service error when a trusted ledger cannot be read.
- Avoid logging credentials, authorization headers, document contents, raw
  connector payloads, or private Box addresses.
- Use parameterized database access and explicit organization filters in
  relational, vector, graph, and audit paths.
- Preserve audit append-only behavior and avoid foreign keys that mutate history.
- Treat browser dashboards, including platform admin/live logs, as privileged
  server-validated session surfaces.
- Commit security phases independently with focused tests and a journal entry;
  never bundle them with UI polish or container cleanup.
