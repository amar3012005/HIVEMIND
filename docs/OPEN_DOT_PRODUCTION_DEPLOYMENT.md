# Open Dot production service

Open Dot is a scoped container service in the canonical SINGULANCE deployment. It runs one
organization and one authenticated user per process. The app has a private network, private data
volume, and a dedicated PostgreSQL container and volume. It does not join or read HIVEMIND's
PostgreSQL service. Core/control-plane remain the identity authority; Open Dot calls the existing
`https://core.singulancelabs.com/auth/session` endpoint with the browser's `hm_cp_session` cookie.

## Immutable image input

Build Open Dot from its own committed integration checkout using an approved external image
builder. The cloud Dockerfile should use an
official Node 24 image pinned by registry digest, and install Open Dot's own package/runtime and
Playwright Chromium dependencies. Do not inherit a local Harness image: it is not available on the
production host, and browser dependency ownership belongs to Open Dot's image. Publish an image
tagged by source commit, then pass the full immutable `repository@sha256:...` reference and matching
40-character Open Dot git SHA to the canonical HIVE-MIND release. The release helper pulls by
digest, confirms the image's `org.opencontainers.image.revision`, and records that digest and source
revision in the release manifest. It never builds Open Dot from the HIVE-MIND worktree.

## Managed environment

Provision these values through the production secret/configuration manager; keep them out of Git
and deployment output:

```dotenv
OPEN_DOT_ORGANIZATION_ID=<existing SINGULANCE organization ID>
OPEN_DOT_USER_ID=<existing authenticated user ID in that organization>
OPEN_DOT_PUBLIC_URL=https://dots.singulancelabs.com
OPEN_DOT_DB_PASSWORD=<unique URL-safe password using letters, digits, underscores, or hyphens>
```

The release helper requires both identity pins and the dedicated database password before enabling
the profile. At runtime, the auth adapter must reject a missing user/org, a mismatched pinned user
or org, an unsigned request, an unavailable auth service, and an auth endpoint redirect. The
process-local browser, provider credentials, and app data must never be shared between users. A
second user requires a separately scoped process, database, data volume, and service identity; this
initial service does not claim multiuser isolation inside one process.

## Release and proxy

Before dispatch, the scoped release mechanism must support both immutable Open Dot image inputs and
the staged proxy route. Confirm DNS/TLS and the route are installed through that approved mechanism.
The snippet below is review material only; this scaffold does not edit the live Caddyfile. If the
release mechanism cannot stage the route and forward the image digest plus source SHA, stop before
dispatch; do not use direct SSH as a fallback.

Once those prerequisites are met, call the canonical production release with only `open-dot`, and
supply the immutable image plus its Open Dot source commit. Its scoped path provisions or starts only
`hm-open-dot-postgres` when needed, leaves a healthy database and its persistent volume alone
during app replacement, then recreates only `hm-open-dot`. The app maps to `127.0.0.1:3177`, with
computer execution disabled until its separately scoped E2B identity is configured and verified.

The app health check calls the unauthenticated `GET /api/health` readiness endpoint, which returns
only service status and a Postgres `SELECT 1` result. It exposes no identity, tenant, or session
data. The public readiness canary verifies only service routing and app/Postgres readiness. The
Caddy site uses existing automatic TLS; do not start a second reverse proxy. After release, run a
separate signed-in canary that proves the configured user/org binding before treating the public
service as live. The unauthenticated health result is not authentication proof.

## State and rollback

Open Dot uses the named `hivemind-open-dot-postgres-data` and `hivemind-open-dot-data` volumes on a
private `hivemind-open-dot` network. Do not map it to `postgres-data`, `hivemind-data`, or the
HIVEMIND Postgres container. App rollback uses the previous immutable image digest recorded by the
canonical release manifest; the database volume is not removed or recreated during rollback. On a
failed first install with no previous Open Dot container/image, stop and remove only `hm-open-dot`
(`docker rm -f hm-open-dot` if Compose state cannot remove it) and remove the dots site block from
the managed Caddyfile, then restart Caddy through its normal procedure. Preserve both Open Dot
volumes for diagnosis; never remove the database or data volume as part of service rollback.
