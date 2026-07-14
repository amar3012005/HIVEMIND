# Production Image Policy

> Authoritative procedure: [`../docs/PRODUCTION_RELEASE_PROTOCOL.md`](../docs/PRODUCTION_RELEASE_PROTOCOL.md).
> Compose runs immutable release tags. The aliases below identify the accepted
> release but must never be supplied as `VERSION` or `NEXT_VERSION`.

SINGULANCE has one production engine at `46.224.4.164`. The authoritative
dashboard is `https://next.singulancelabs.com/hivemind`; the homepage is
served separately at `https://singulancelabs.com`.

| Service | Runtime container | Latest tag | Stable tag |
| --- | --- | --- | --- |
| Core memory API | `hm-core` | `hivemind/core-api:latest` | `hivemind/core-api:stable` |
| Control plane | `hm-control` | `hivemind/control-plane:latest` | `hivemind/control-plane:stable` |
| HyperAgents sidecar | `hm-employees` | `hivemind/employees:latest` | `hivemind/employees:stable` |
| Dashboard frontend | `hivemind-next-frontend-1` | `hivemind/fe:latest-single` | `hivemind/fe:stable-single` |
| Homepage frontend | `hm-fe` | `hivemind/fe:home-latest` | `hivemind/fe:home-stable` |

The other running containers are infrastructure or product integrations:
Postgres, Qdrant, Redis, Caddy, Docling, Nango, Playwright, BYOD broker,
TARA, Deepgram, and Waitlist Relay. They do not follow the application release
tag rotation unless their own deployment is intentionally changed.

Retain the active immutable release, timestamped rollback tags, and the aliases
in this table. Remove only dangling images and disposable build cache after
rollback tags are verified. Persistent volumes are never pruned.
