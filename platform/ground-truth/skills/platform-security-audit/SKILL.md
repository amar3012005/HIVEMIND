---
name: platform-security-audit
description: Review SINGULANCE tenant isolation, Cloudflare edge controls, secrets, admission, and release boundaries before a sensitive or production change.
---

# Platform security audit

Read `../../platform.yaml` and `../../delivery-contract.md`. For Cloudflare work,
load the Cloudflare skill and retrieve current product documentation before
recommending account-level controls.

1. Map request path, authenticated principal, tenant/project authorization,
   service trust boundary, secret source, and persisted data owner.
2. Prove cross-tenant denial, expired admission rejection, least-privileged
   service access, and redaction of provider credentials/receipts.
3. Review public APIs for schema validation, session-aware rate limits, WAF rules,
   and origin protection through Access/Tunnel where the product plan supports it.
4. Treat security controls as versioned configuration with rollback and test
   receipts. Do not mutate Cloudflare account policy during an audit unless the
   user explicitly requests that change.
