# Open Dot production service

Open Dot is a scoped container service in the canonical SINGULANCE deployment. The initial
deployment is a single-user local prototype bound to the signed-in SINGULANCE workspace owner
AMAR (`amarsai2005@gmail.com`). Core/control-plane remain the identity authority; Open Dot calls the existing
`https://api.singulancelabs.com/auth/session` endpoint with the browser's `hm_cp_session` cookie.
The local prototype uses a dedicated persistent data volume and requires
`DOTS_PROTECTED_LOCAL_SERVER=1`; requests must authenticate and match the owner binding before
pages, server actions, or APIs are served. Its no-data health endpoint and static assets do not
grant application access. Do not copy a developer machine's local database or secrets.

The prior isolated PostgreSQL deployment remains available as `cloud` mode. It uses the
`open-dot` Compose profile and its existing dedicated database/data volumes. The local prototype
uses the separate `open-dot-local` profile and `hivemind-open-dot-local-data`; it does not start
or connect to PostgreSQL. These modes share the immutable Open Dot image and loopback port, so
they are mutually exclusive for a given release.

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

The versioned local-prototype setup resolves the two owner IDs from the live Core database using
the exact verified account and active SINGULANCE owner membership. It uses the immutable running
Core image in a disposable read-only container, writes only these non-secret binding values to the
managed configuration with a private backup and atomic replace, and never prints IDs or credentials:

```dotenv
OPEN_DOT_ORGANIZATION_ID=<existing SINGULANCE organization ID>
OPEN_DOT_USER_ID=<existing authenticated user ID in that organization>
OPEN_DOT_PUBLIC_URL=https://dots.singulancelabs.com
```

The helper requires exactly one active, undeleted owner membership for that account and workspace;
it refuses ambiguity or conflicting existing values. The `cloud` mode additionally requires a
unique PostgreSQL password. At runtime,
the auth adapter must reject a missing user/org, a mismatched pinned user
or org, an unsigned request, an unavailable auth service, and an auth endpoint redirect. The
process-local browser, provider credentials, and app data must never be shared between users. A
second user requires a separately scoped process, database, data volume, and service identity; this
initial local prototype does not claim multiuser isolation inside one process.

## Release and proxy

Dispatch the exact immutable Open Dot image digest, matching 40-character source SHA, and
`open_dot_mode=local-prototype` through the scoped release gateway. Its canonical release helper
starts only `hm-open-dot` with the local profile, waits for healthy status and matching artifact
identity, then installs `dots.singulancelabs.com` through the versioned managed Caddy API helper.
That helper uses the existing Caddy config and bind-mounted file, refuses drift, and does not add a
second proxy. The release then requires a TLS-validated public `/api/health` response; it does not
skip certificate verification. DNS must resolve to the managed host and the existing Caddy setup
must be able to provision TLS. If health, route installation, or TLS verification fails, the
release stops before reporting success.

The managed setup still needs the owner IDs populated before dispatch. Once configured, the release
recreates only `hm-open-dot`, maps it to `127.0.0.1:3177`, and leaves computer execution disabled
until its separately scoped E2B identity is configured and verified. The default mode remains
`cloud`; select `local-prototype` explicitly for this first single-user instance.

The app health check calls the unauthenticated `GET /api/health` readiness endpoint, which returns
only service status. In cloud mode it also checks Postgres readiness. The public health result
proves routing and readiness only, not authentication. After release, run a separate signed-in
canary that proves the configured user/org binding before treating the app as live.

## State and rollback

Cloud mode uses the named `hivemind-open-dot-postgres-data` and `hivemind-open-dot-data` volumes;
local-prototype mode uses only `hivemind-open-dot-local-data`. Neither mode uses HIVEMIND's shared
Postgres or app-data volumes. App rollback uses the previous immutable image digest recorded by the
canonical release manifest. Preserve all Open Dot volumes during diagnosis and rollback.
