# Engine Box release gates

No branch commit, container health endpoint, or successful image build promotes
Engine Box. A signed candidate must produce the following receipts before
canary, then repeat them for stable:

1. clean detached source worktree, exact parent and frontend SHA, image digest,
   SBOM, provenance, vulnerability report and offline manifest signature;
2. fresh amd64 and arm64 Ubuntu 22.04/24.04 appliance installations;
3. interruption and repair at every installer stage, with no duplicate
   installation/document/segment data;
4. authenticated evidence and `both` ingestion, exact count reconciliation,
   citations/provenance, metadata sanitation and idempotent retry;
5. REST, chat and MCP filtered hybrid/temporal/relationship parity, including
   evidence-only and compound queries;
6. OIDC/RBAC, scoped-key revocation, break-glass recovery and lease expiry;
7. local/customer/Cloudflare route consent, compatible fallback and no-content
   egress packet capture in sovereign mode;
8. customer-data-plane restart, full disk, failed migration, corrupt artifact,
   rollback, backup/restore, export/erase and Cloudflare-disconnect drills;
9. load/soak p50/p95/p99 measurements per certified hardware tier;
10. signed pilot acceptance, security approval and the DPA/DPIA/subprocessor
    pack.

The legacy BYOD Memory Box remains on its own release contract until migration
is explicitly completed. It cannot be silently enrolled as an Engine Box.
