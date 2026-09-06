# Cloudflare Flagship feature ground truth

## Scope

This release path separates **feature entitlement** from deployment configuration.

- Cloudflare Flagship is the runtime authority for approved rollout capabilities.
- Environment files continue to hold secrets, service addresses, resource limits, and safe static configuration.
- Neither environment variables nor Cloudflare Flags carry tenant content, prompts, memories, embeddings, or API secrets.

Authorization and externally mutating capabilities fail closed when their Flagship endpoint is unavailable or returns an invalid response. Knowledge ingestion is deliberately different: its authenticated Workflow endpoint makes the lane available, Flagship selects that lane per organization, and an admission-time Flagship/transport outage selects the local BullMQ lane before any job or source object is persisted. The selected orchestration mode is then latched on the durable job. It never consults a host feature boolean.

## Current canonical mappings

| Legacy environment gate | Flagship key | Runtime path |
| --- | --- | --- |
| `ENABLE_TOOLS_HITL` | `enable-tools-hitl` | governed tool HITL |
| `USE_TOOLS_DURABLE_AGENT` | `use-tools-durable-agent` | durable tool agent |
| `PARTNER_REFERRALS_ENABLED` | `partner_referrals_v1` | partner-referral lifecycle |
| `USE_TOOLS_UNIFIED_DAG` | `USE_TOOLS_UNIFIED_DAG` | frontend Flagship surface |
| `KNOWLEDGE_INGEST_WORKFLOW_ENABLED` | `knowledge_ingest_workflow_v1` | Workflow-primary knowledge ingestion; BullMQ admission fallback |

Only the entries above are migrated by this change. `KNOWLEDGE_INGEST_WORKFLOW_URL`, its secret, and its environment label remain deployment configuration. Do not infer a Flagship mapping for another `ENABLE_*`, `USE_*`, or tuning variable: many are infrastructure/model settings and need their own reviewed migration.

## Release contract

Every production deployment must be assembled from one immutable release record containing:

```json
{
  "backend_source_sha": "<exact git SHA>",
  "frontend_source_sha": "<exact git SHA>",
  "images": {
    "hm-core": "<repository>@sha256:<digest>",
    "control-plane": "<repository>@sha256:<digest>",
    "employees": "<repository>@sha256:<digest>",
    "hm-extract": "<repository>@sha256:<digest>",
    "hm-playwright": "<repository>@sha256:<digest>"
  },
  "frontend_worker_version": "<Cloudflare Worker version ID>",
  "flagship_app_id": "<Cloudflare Flagship app ID>",
  "compose_profile": "production"
}
```

No mutable image tag (`latest`, a branch name, or an unpinned SHA tag) is a release record. This prevents a mixed deployment where Core, Control Plane, frontend, and extraction services originate from unrelated commits.

## Environment cleanup procedure

1. Copy the production environment file to a protected local audit location; never paste it into chat, tickets, or source control.
2. Run `node scripts/audit-production-env.mjs <copied-env-file>`. It reads only variable names and never prints values.
3. Keep `secret` and `infrastructure` entries. Review `review` entries individually.
4. After this release is deployed and the Flagship endpoint is verified, remove the legacy rollout booleans listed by the script, including `KNOWLEDGE_INGEST_WORKFLOW_ENABLED` and `KNOWLEDGE_INGEST_PRODUCTION_ACK`.
5. Keep feature-flag **endpoint** configuration (`*_FLAG_URL`, `CLOUDFLARE_FEATURE_FLAGS_URL`) until a separately reviewed configuration consolidation replaces it. These are routing settings, not enablement switches.

## Go-live guard

Changing these readers means a Flagship value of `true` can now activate the corresponding capability without a local boolean override. Before production rollout, verify the desired Flagship values against a canary release, validate a real governed-tool and referral lifecycle, then publish the immutable release record.
