# HIVE native Harness chat handoff

## Authority and scope

- Development base: `origin/singulance-local` at `0035027205b84e60e58fefa5ca0f1aa95cea2adc`.
- Harness: `amar3012005/deepseek-harness-hivemind`, branch `hivemind-chat`, commit `980a9d66e373d9c3a1a29f249968c44991280d18`.
- Da-vinci gitlink: `c0032dd4de663476f8f55d061a847dbf9bfeb8ed`.
- `singulance-main` and production were not changed and are forbidden until the acceptance checklist is green.
- HyperAgents is outside this task.

## Canonical architecture

Use `./scripts/harness-chat-env` only. It composes:

1. `docker-compose.local-stack.yml` — Core, PostgreSQL, Redis, Qdrant.
2. `docker-compose.local-services.yml` — Control Plane and local services.
3. `infra/docker-compose.hivemind-chat.yml` — shared admission secrets and the complete native Harness runner.

All services use project `hivemind-chat-local` and network `hivemind-network`.
Control Plane owns identity/admission; PostgreSQL owns Harness session/events;
Redis owns admission nonces/coordination; Core owns HIVE memory and governed
business APIs. The runner image contains the complete native profile and may not
use package-level bind mounts.

## Completed setup

- Added the canonical Compose overlay and an untracked environment template.
- Locked Harness and Da-vinci commits plus the HIVE baseline.
- Added `status`, `doctor`, `up`, `up-all`, `restart`, `test`, and `down` commands.
- `up` rebuilds only the runner and uses Docker cache; `restart` uses no build.
- Added architecture, decisions, local runbook, and E2E acceptance documents.
- Doctor rejects production branch use, SHA drift, missing configuration,
  recovery overlays, package bind mounts, invalid Compose, and duplicate backend generations.

## Current runtime finding

Two HIVE backend generations are running now:

- `hivemind-api`, `hivemind-control-plane-local`, `hivemind-postgres`, `hivemind-redis` on `hivemind-network`.
- `hm-core`, `hm-control`, `hm-postgres`, `hm-redis` on `hivemind-dev_default`.

Therefore `./scripts/harness-chat-env doctor` intentionally fails with
`duplicate HIVE backend generations are running`. Do not weaken this check.
Resolve which generation owns the shared preview from the permanent local
integration worktree before admission testing. Do not delete volumes.

## Required local secrets

Copy `infra/.env.hivemind-chat.example` to the ignored
`infra/.env.hivemind-chat.local` and replace placeholders. The ticket and runner
service secrets must be distinct and at least 32 bytes. Keep Composio and
Cloudflare credentials server-side. Never paste their values into logs or git.

## Verification evidence

```text
bash -n scripts/harness-chat-env
exit 0

git diff --check
exit 0

./scripts/harness-chat-env status
HIVEMIND codex/singulance-chat-local 003502720...
Da-vinci c0032dd4...
Harness hivemind-chat 980a9d66...
```

Compose interpolation and model validation passed with temporary non-secret
test values; doctor then stopped at the duplicate-generation gate as designed.
The resolved `hivemind-web` profile dump contains the HIVE web-app patch. The
connected-apps workspace package resolves from the owning agent-presets package;
its focused suite passed 9/9. Worker tests were not run because that package's
local dependencies are absent.

## Unmet acceptance criteria

- Select one local backend generation and stop the other without deleting data.
- Create the ignored local environment file with real development secrets.
- Boot the canonical project from the permanent local integration worktree.
- Prove bootstrap 200, establish 200, boot 200, cookie set, and WebSocket upgrade.
- Complete authenticated native-renderer, session replay, Composio lifecycle,
  failure retry/idempotency, and second-tenant isolation checks.
- Pin immutable image digests before any production proposal.

## Decisions

- Existing recovery overlays remain in git for forensic history but are never
  part of the canonical command.
- No running container was stopped from this feature worktree.
- No UI, Core, Control Plane, Worker, or production code was changed here.

## Exact next action

From the permanent clean `singulance-local` integration worktree, identify the
backend generation serving preview, stop only the duplicate generation without
deleting volumes, create `infra/.env.hivemind-chat.local`, and run
`./scripts/harness-chat-env doctor` followed by `./scripts/harness-chat-env up`.
