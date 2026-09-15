---
name: platform-release
description: Deterministically release SINGULANCE frontend, Core, Harness runner, HyperAgents, and Tara changes across local, Enigma, and production.
---

# Platform release workflow

Read `../../platform.yaml` and `../../delivery-contract.md` first. For a
Cloudflare change, load the Cloudflare plugin skill and use the current docs and
the bound account/project rather than assumptions.

1. Classify the changed artifact and environment. Capture current source SHA,
   artifact identity, configuration revision, health, and rollback target.
2. Work from a clean branch aligned with its canonical environment branch.
3. Run focused tests and the owning build only.
4. Release only the changed artifact using its canonical helper. Preserve server
   secrets, networks, volumes, ticket configuration, and provider credentials.
5. Verify the deployed artifact identity and authenticated browser/service canary.
6. Record the release lock before expanding any feature flag cohort.

### Model handoff

- Luna executes only a checked-in command from this skill or a generated release
  manifest after confirming its environment and SHA.
- Terra implements a bounded change only after its owner, tests, and rollback are
  specified.
- Sol/Astra own cross-service design, new contracts, security review, and any
  deviation. They must reduce their decision into a versioned release manifest
  before delegating execution.

No raw Docker Compose recreation, mutable `latest` image, copied `.env`, manual
container patch, or assumed Cloudflare binding is allowed.
