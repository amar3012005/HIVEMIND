# HIVEMIND Engine Box

Engine Box is the proprietary, self-hosted HIVEMIND memory appliance. It is not the legacy BYOD data-plane agent: documents, evidence, memories, recall, temporal/graph tools, MCP and grounded chat execute on the customer server.

## Customer flow

1. An organization owner opens **Set up Engine Box** in the HIVEMIND portal.
2. The portal issues a single-use enrollment code and displays the one-command bootstrap.
3. The customer runs it on a supported Linux server with `sudo`.
4. The installer verifies a signed manifest, supervisor, appliance bundle and image digests before it starts services.
5. Local readiness and optional outbound Cloudflare management connectivity are both verified before the portal reports `Connected`.

The customer receives images and signed artifacts, never the HIVEMIND repository. A rerun is a repair action and never deletes data volumes.

## Data boundary

- Local by default: uploaded content, embeddings, evidence, memories, graph, prompts and answers stay on the Engine Box.
- Central portal: installation ID, version, health state, aggregate counts and update status only.
- Cloudflare AI Gateway: disabled until a local administrator records egress consent. Consent is auditable and revocable.
- Local operation remains available if Cloudflare or Singulance is unavailable. A valid signed lease permits full operation for 30 days; after expiry, the appliance becomes read-only while recall, export, erasure and backups remain available.

## Release bundle contract

The offline signer creates a signed `release.json` plus `release.sig` and `release.pub`. The manifest contains the exact supervisor binary, appliance bundle and OCI image digests. `install.sh` rejects unsigned manifests, altered artifacts and unpinned images.

`compose.yaml` intentionally requires manifest-provided digest variables. It must never be launched with mutable image tags.

## Local service inventory

| Service | Role |
| --- | --- |
| PostgreSQL | documents, evidence, memories, provenance, audit and jobs |
| Qdrant | tenant-filtered vectors |
| Redis | durable ingestion and idempotency queues |
| hm-core | canonical memory API, recall, temporal/graph and chat |
| hm-ingestion | asynchronous canonical ingestion |
| hm-extract | document parsing |
| hm-playwright | opt-in browser extraction |
| hm-model-router | verified local/customer/cloud model routing |
| hm-mcp | memory-specific MCP endpoints |
| hm-supervisor | installation, health, update and rollback authority |

## Development safety

Run the focused foundation checks:

```bash
node --test engine-box/tests/runtime-contract.test.mjs
node --test core/tests/unit/engine-box-runtime.test.mjs
bash -n engine-box/install.sh
cargo check --manifest-path engine-box/supervisor/Cargo.toml
```

No production deployment, Cloudflare account change, customer enrollment, tunnel creation, or release signing is performed by these local tests.
