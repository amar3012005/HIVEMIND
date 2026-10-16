# Cloudflare security-audit-skill integration

Upstream: `cloudflare/security-audit-skill` at
`c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (main verified 2026-09-15), MIT.

Use this upstream methodology only for a requested full audit or penetration
review. It supplies six useful phases: reconnaissance; coverage-led hunting;
fresh candidate validation; structured findings; independent record
verification; and target-neutral reporting.

Run audit artifacts in an ignored, assigned output directory. Do not treat a
hardening suggestion as a vulnerability. Findings are `confirmed` only with a
source trace and bounded observed result; otherwise use `needs_validation` or
`rejected`. A finder does not validate its own finding.

For SINGULANCE, add these mandatory audit units before reporting:

- Core/Worker/runner admission and signed ticket/JWT boundaries.
- Tenant and project isolation for memories, entities, receipts, and cache.
- Cloudflare Access/Tunnel/origin exposure, API schema validation, rate limits,
  and WAF/ruleset configuration where enabled.
- Cordis plugin/tool projection, approval lifecycle, provider receipt redaction,
  and release artifact provenance.

The upstream repository is a method reference, not a new platform owner or a
reason to copy its whole tree into product repositories.
