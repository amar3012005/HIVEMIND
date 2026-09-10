# HIVE Harness chat local runbook

## Branches

| Repo | Branch | Role |
| --- | --- | --- |
| HIVEMIND | `singulance-local` or this worktree | Core, Control Plane, Compose, Worker, Da-vinci gitlink |
| `amar3012005/deepseek-harness-hivemind` | `hivemind-chat` | Native Harness runtime and profile |
| Da-vinci submodule | HIVE chat frontend SHA | Shell + Harness mount |
| HIVEMIND | `singulance-main` | Production only. Do not edit. |

Preferred worktree: `/Users/amar/HIVE-MIND-singulance-chat-local`.
Do not develop this feature in the dirty `/Users/amar/HIVE-MIND` `main` checkout.

## Start

```bash
cd /Users/amar/HIVE-MIND-singulance-chat-local
./scripts/harness-chat-env status
./scripts/harness-chat-env doctor
```

Bring the complete origin stack up once, then rebuild only the runner:

```bash
cp infra/.env.hivemind-chat.example infra/.env.hivemind-chat.local
# Replace placeholders in the untracked local file; never commit secrets.
./scripts/harness-chat-env up-all
```

Use `./scripts/harness-chat-env up` for a runner-only cached rebuild.
Use `./scripts/harness-chat-env restart` when no image input changed.
`stop-foreign` removes leftover `hm-*`, compat, and extra-tunnel containers
without deleting volumes.

Do not stack `infra/docker-compose.harness-hotfix.yml` on top unless recovering
a previously admitted backend. That file bind-mounts package outputs and is how
profile/image drift returns.

## Admission trace

```text
/v1/harness-chat/bootstrap          → ticket issued
/api/hivemind/session/establish     → session cookie, not 401/403
native /api/remote.mux              → WebSocket upgrade on the same origin
```

Control plane and runner must share:

- `HIVE_HARNESS_TICKET_SECRET`
- runner service secret
- Redis URL/database
- parent origins (`https://next.preview.singulancelabs.com` for preview)
- profile name `hivemind-chat`

Never print those secret values.

## Stop

```bash
./scripts/harness-chat-env down
```

## Recurring failure classes

| Symptom | Likely cause |
| --- | --- |
| Chat unavailable / 401 establish | Ticket secret or Redis mismatch |
| 403 establish | Origin / trusted host / parent origin mismatch |
| preset `hivemind-chat` cannot resolve `dsh-hivemind-connected-apps` | Profile mounted over an image that lacks the plugin |
| `Access to storage is not allowed from this context` | Native storage used in a non-secure/embedded context |
| `/api/remote.mux` failed | Worker stripped the WebSocket upgrade or tunnel origin is wrong |
| Sessions vanish | Runner using in-memory state instead of PostgreSQL |
| Login “control plane unavailable” | Local overlay replaced control-plane image/env |
| UI missing tables/reasoning | Browser bundle built from a stripped profile, not native `web` |
