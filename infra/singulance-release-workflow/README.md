# SINGULANCE production release Workflow

Deterministic production deploys. One Cloudflare Workflow chooses the artifact
and locked git ref; GitHub Actions is the only executor (Wrangler cannot SSH
to Hetzner from a Worker).

| `artifact` | Git ref (locked) | Executor | Public canary |
|---|---|---|---|
| `frontend` | Da-vinci `main` | `singulance-production-frontend.yml` | `https://next.singulancelabs.com/` |
| `core` | HIVEMIND `singulance-main` | `singulance-production-hetzner.yml` | `https://api.singulancelabs.com/health` |
| `control-plane` | HIVEMIND `singulance-main` | same | same |
| `employees` | HIVEMIND `singulance-main` | same | same |

Enigma (`dev.next`) and preview are **not** in this Workflow. They keep their
own Workers (`hivemind-web-enigma`, `hivemind-web-preview`).

## Trigger

```bash
curl -X POST https://singulance-release.<subdomain>.workers.dev/v1/release \
  -H "Authorization: Bearer $RELEASE_TRIGGER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"artifact":"frontend","requested_by":"amar"}'

curl -H "Authorization: Bearer $RELEASE_TRIGGER_SECRET" \
  https://singulance-release.<subdomain>.workers.dev/v1/release/<instanceId>
```

Also triggerable from the Cloudflare dashboard: Workers → `singulance-release` → Workflows.

## Secrets (Worker)

```bash
npx wrangler secret put RELEASE_TRIGGER_SECRET
npx wrangler secret put GITHUB_TOKEN   # repo scope: actions:write + contents:read on Da-vinci and HIVEMIND
```

## Secrets (GitHub)

Da-vinci: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`  
HIVEMIND: `SINGULANCE_SSH_KEY`, `SINGULANCE_SSH_HOST` (default `singulance`)

## Deploy this Workflow

```bash
cd infra/singulance-release-workflow
npx wrangler deploy
```

Does **not** overwrite `hivemind-web`.
