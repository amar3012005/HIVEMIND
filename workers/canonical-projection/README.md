# Canonical projection lifecycle

Durable, feature-gated orchestration for Phase 0 canonical entity and claim projections. This Worker never carries memory content through Cloudflare. Queue and Workflow payloads contain only `memory_id`, opaque `org_id`, `processing_version`, and the admission-latched `required_projection` mode.

## Admission and rollout

`POST /start` requires the `CANONICAL_PROJECTION_ADMISSION_SECRET` bearer secret and `x-hivemind-user-id`. It evaluates Flagship flag `canonical_knowledge_foundation_v1` against the tenant/user pair. The environment kill switch `CANONICAL_KNOWLEDGE_ENABLED` defaults to `false`; missing bindings, errors, invalid identities, `off`, or unknown variations fail closed.

Allowed variations are `shadow`, `write`, `read`, and `full`. The chosen value is latched into the identifier-only envelope before Queue admission. A deterministic Workflow ID, `claim-{memory_id}-v{processing_version}`, makes duplicate deliveries converge on one run.

## Core callbacks

The Workflow calls Core stages in order: `load`, `reconstruct`, `resolve`, `normalize`, `persist`, `reconcile`, and `complete`. Core remains the semantic authority and loads the authorized memory by ID. Failure recording uses the `failed` stage.

Every callback is HMAC-SHA256 authenticated with secret `CANONICAL_PROJECTION_HMAC_SECRET`. Headers are:

- `x-hivemind-timestamp`
- `x-hivemind-nonce`
- `x-hivemind-content-sha256`
- `x-hivemind-signature: sha256={hex}`

The signed canonical value is `timestamp + "\\n" + nonce + "\\nPOST\\n" + pathname + "\\n" + sha256(exact_body)`. Core must reject stale timestamps and replayed nonces.

## Local verification

```sh
npm ci
npm run types
npm run check
npm test
npm run dry-run
```

Create both primary and DLQ resources before deployment. Configure both secrets with `wrangler secret put`; never add them to Wrangler config. Production remains disabled until the kill switch and exact Flagship canary targeting are deliberately enabled.
