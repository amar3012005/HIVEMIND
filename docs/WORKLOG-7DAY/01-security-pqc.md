# 01 — Security: Post-Quantum Cryptography

All landed **Jun 3**. Defense-in-depth across transport, memory integrity, and audit trail.

## Commits

| SHA | Summary |
|-----|---------|
| `aa8edb0` | Hybrid post-quantum TLS (X25519MLKEM768) on Caddy |
| `bdb2a27` | PQC signatures — ML-DSA memory integrity + SLH-DSA chained audit |
| `162ea53` | Harden PQC endpoints — auth + tenant scope, anti-fork lock, genesis anchor, lockfile |
| `0e67b12` | Audit-chain defense-in-depth — append-only trigger + signed tail checkpoints |

## What was built

### Transport (FIPS 203)
- **X25519MLKEM768** hybrid key exchange on Caddy. Classical X25519 ⊕ ML-KEM-768
  so a "harvest-now-decrypt-later" quantum attacker cannot retroactively break TLS.

### Memory integrity (FIPS 204 — ML-DSA-65)
- `pqc-signer.js`: sign/verify with **env-only secret keys** (`PQC_*_SK`, kept
  separate from the DB), canonical-JSON + sha256.
- `createMemory` signs `{id, user_id, org_id, content}` → `memory_signatures`
  side table, **in-transaction, sub-millisecond**.
- Graceful no-op if keys/lib absent → dark-safe.

### Audit trail (FIPS 205 — SLH-DSA-SHA2-128s)
- `audit-logger` fire-and-forget signs a **hash-chained** entry
  (`prev_hash → entry_hash`) → `audit_signatures`, off the request path.
- **L1 append-only trigger** (`append_only_guard`) on `audit_signatures` +
  `audit_checkpoints`: a `BEFORE UPDATE/DELETE` trigger that fires for **every
  role including the table owner** — so even a compromised app role cannot
  delete/mutate the signed trail (a plain `REVOKE` wouldn't stop the owner).
- **H5 signed tail checkpoints**: the hash chain catches mutation/reorder/head-
  truncation but NOT deletion of the newest entries. New `audit_checkpoints`
  table anchors `(org_id, max_seq, head_entry_hash, row_count)` under an SLH-DSA
  signature, written hourly per-org (advisory-locked).

### Verification endpoints
`GET /api/security/pqc` (status + pubkeys), `/verify-memory?id=`, `/audit-verify`
(walks + verifies the chain: signature, linkage, payload-binding, latest
checkpoint, no-tail-regression). All auth-gated + tenant-scoped.

## Posture
Dependency pinned (`@noble/post-quantum 0.6.1`). Secret keys live in env ONLY —
never DB, never git. Documented separately in the security Notion page.
