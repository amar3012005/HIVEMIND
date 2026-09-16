---
name: platform-release
description: Safely release SINGULANCE frontend, backend, Worker, container, migration, and rollback changes across local, Enigma, or production.
---

# Platform release

Select the manifest for the requested environment. Resolve its exact source SHA before building.
Build an immutable affected artifact, deploy or recreate only affected services, then verify health
and the real route. Record the prior artifact/version as rollback before cutover.

Do not use a local or Enigma release mechanism in production. Never patch a running container,
copy `.env` files between environments, or treat build success as authenticated-route proof.
