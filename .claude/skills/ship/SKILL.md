---
name: ship
description: Release a reviewed HIVEMIND commit without stale code or lost rollback.
---

# Ship

Do not derive a deployment command from this skill. Read and execute
`docs/PRODUCTION_RELEASE_PROTOCOL.md` exactly, using the current
`docs/PRODUCTION_RELEASE.md` ledger and `docs/BRANCH_PROTOCOL.md`.

Required preconditions:

- complete pushed parent commit on `singulance-main`;
- pushed frontend commit referenced by a clean gitlink;
- no conflicting release owner;
- tests and migrations reviewed;
- rollback images and required data backup prepared.

Required closeout:

- runtime image digests and release identity;
- public plus authenticated feature acceptance;
- fresh error-log result;
- rollback reference;
- accepted release entry in both release and engineering journals.

Never use `myserver`, `docker cp`, an ad-hoc `docker run`, a dirty checkout,
mutable tag as release input, blind pull/reset, or in-place repair.
