# HIVEMIND — Bring-Your-Own-Data (BYOD) self-host architecture

**Status:** design (production plan) · **Date:** 2026-06-26 · **Owner:** platform
**Source:** recon — web research (data-residency products) + 4-dimension seam audit of the codebase.

---

## 0. The one thing to internalise first

There are **two different promises** hiding under "self-host your data". Conflating them is the
fatal mistake. State which tier you are selling, per customer, in writing.

| Tier | Promise | What it means | Achievable |
|------|---------|---------------|------------|
| **T1 — Data-at-rest residency** | Your *stored* memory lives on *your* box. | The `.amr` file (or your Postgres+Qdrant) is on the customer's server. Our engine reaches it over a secure outbound tunnel. **Raw content still transits our engine + third-party LLMs during processing.** | **Yes** — driver + remote agent + fix the seam bypasses. Weeks. |
| **T2 — Zero-egress residency** | *Nothing* leaves your box, ever. | No tenant text/audio/image ever reaches Groq/OpenRouter/pyannote/LiteLLM/our disk. | **Only with on-prem inference** (LLM+STT+vision+embeddings, GPU) **or customer-supplied LLM keys**. Months, or shift egress to the customer's own provider account. |

**`.amr` solves storage residency. It does NOT solve egress residency.** The "thinking layer"
(distillation, entity extraction, synthesis, STT, diarization, vision-OCR, embeddings) ships raw
tenant content to third parties today — that's ~13 egress points, several **unavoidable without local
models**. Sell T1 honestly; offer T2 as an enterprise tier.

---

## 1. The architecture (the correct pattern)

Web research verdict: **this is a reverse-tunnel / outbound-agent problem, not a sync-engine
problem.** Sync engines (PowerSync, ElectricSQL, Turso embedded replicas, Prisma Pulse) all make the
**central service dial INTO** the customer DB (inbound replication/CDC) or put the **write-primary in
our cloud** — both break the residency promise. The only shape that fits "engine central, data on the
customer box, outbound-only, paste-a-key" is a **thin agent that dials out + a per-tenant remote
driver** in the engine.

```
┌──────────────── OUR SERVER (central engine, unchanged pipeline) ───────────────┐
│  hm-core ── storage driver (vector/mneme/driver.js) ── 4th mode: "remote"       │
│      org local-.amr → local file   |   org hybrid → central PG+Qdrant            │
│      org BYOD       → Tunnel Broker ── routes by tenant_id ──► held tunnel       │
└────────────────────────────────────────────────▲──────────────────────────────┘
                                                   │  held, OUTBOUND-initiated
                                                   │  wss/HTTP2 :443 · mTLS · E2E
┌──────────────────────────────────────────────────┴────────────────────────────┐
│  CUSTOMER BOX (data plane only)                                                 │
│   hm-agent (one small binary)  ── dials out on boot with the pasted key         │
│        executes scoped queries locally, returns ONLY results down the tunnel    │
│   store:  .amr file        OR     Postgres + Qdrant                              │
└─────────────────────────────────────────────────────────────────────────────-─┘
```

This maps **directly onto the driver we already built**: the driver is the seam. BYOD adds
`driver mode = remote` for those orgs — `wrapPrisma` / `amrRecall` / `amrWrite` marshal the call over
the tunnel instead of touching a local `.amr`/PG. **Same pipeline, same features; only "where the
data is" changes.**

### Transport — pick by customer profile
- **Default (lowest friction): your own agent over a reverse WebSocket/HTTP2 + mTLS tunnel** (the
  Teleport / Envoy-reverse-tunnel / OpenAI-Secure-MCP-Tunnel pattern). Agent dials out on 443,
  long-polls so the connection **auto-establishes the instant the key is pasted**. No inbound port, no
  IP allowlist, no VPN install, **no third party in the data path** (you own the crypto).
- **Regulated / provable-E2E: Tailscale or self-hosted Headscale (WireGuard).** Data plane is direct
  P2P, E2E even through a relay; the coordination server only brokers public keys. Cost: they install
  a client.
- **Avoid Cloudflare Tunnel / ngrok as primary** — they terminate TLS at *their* edge (plaintext
  visible) unless you wrap inner TLS; just own it with your agent.

### The "paste an API key" flow (do the layered version, not a flat key)
1. Customer creates a connection in their dashboard → we mint a **short-lived enrollment token** +
   designate a **per-tenant client certificate** (agent CSRs on first boot, we sign).
2. Agent uses the token **once** to bootstrap mTLS, then authenticates every reconnect with the
   **client cert**. **Bind the token to the cert (RFC 8705 / DPoP)** so a stolen token alone is useless.
3. Broker **locks each tunnel's destination server-side** to that one tenant's data endpoint — an
   agent can reach only its own `.amr`/PG, never another tenant's, never our internal hosts (SSRF lock).
4. Rotation + revoke from the dashboard kills the tunnel immediately.

---

## 2. The honest residency reality (egress audit)

`.amr` keeps **stored** data on the box. But these **egress points ship raw tenant content out** and
must be addressed for any residency claim. From the audit:

**Unavoidable-without-local-models (the thinking layer):** fact distillation (full doc text → Groq),
entity extraction + co-mention linking (segment text → Groq), conflict resolution, fact/keyphrase
extraction, memory synthesis / dreaming, **meeting STT (raw audio → Groq Whisper)**, **diarization
(raw audio → pyannote.ai)**, **vision/OCR (PDF/image base64 → Groq)**, query expansion.

**Localisable / opt-out:** embeddings (→ local BGE-M3/ONNX), cross-encoder rerank (→ self-host TEI),
docling PDF parse (already self-hostable; picture-descriptions opt-in), web search (Tavily, optional),
profile dreaming (default OFF).

**Customer-supplied-key (egress becomes THEIR account):** HyperAgents director, Hermes agent, Nango
connectors — already provider-pluggable; let the customer bring their Groq/OpenRouter/Nango keys.

→ **T1 mitigation that ships now:** route ALL LLM/embedding/STT/vision calls for a BYOD org through
**the customer's own provider keys** (their egress, their audit trail) + make audio/vision/dreaming
**opt-in** + document the egress table in onboarding. **T2 (true zero-egress):** add a local-inference
profile (Ollama/vLLM + local Whisper + local pyannote + local embeddings) — 16–24 weeks + GPU.

---

## 3. Remediation list — every seam bypass to fix before BYOD is leak-free

The driver is the seam; anything below **bypasses it** and would hit the **central** store/disk for a
BYOD org. Fix order: correctness-blocking first.

### 3a. Relational bypasses (would read/write central Postgres)
- **`new PrismaClient()` outside the seam (12 files):** `compliance/gdpr-erasure.js`,
  `compliance/gdpr-export.js`, `compliance/data-inventory.js` (**CRITICAL** — erase/export/inventory
  would hit the wrong DB), `audit/*`, `services/audit-log.service.js`, `db/seed.ts`,
  `vector/mneme/*.cjs` (dev utils). **Fix:** import `getPrismaClient()`; never construct a client in
  the request path. Compliance ones are P0 (wrong-store deletion/export = data-integrity + GDPR bug).
- **Raw SQL — `$queryRawUnsafe` / `$executeRawUnsafe` (24 files, ~16 in the memory path):** `server.js`
  (33), `control-plane-server.js` (27), `resident/governance-routes.js` (9), `resident/{run-manager,
  scheduler,cognition-pilot,budget-pool}.js`, `memory/{cluster-index,entity-resolver,cognition-loop,
  profile-dreamer,evolution-engine,bi-temporal}.js`, `prisma-graph-store.js` (FTS). Raw SQL **cannot
  route to `.amr`** (no adapter). **Fix:** (i) move write/CRUD raw SQL to ORM store-methods so the
  driver routes them; (ii) for unavoidable raw reads (FTS, advisory locks), **fail-loud for a BYOD
  org** (the driver throws `MnemeUnsupported`) OR implement the equivalent in the `.amr` query engine.
  **DANGER call out:** `control-plane-server.js` `ALTER TABLE "memories" DISABLE TRIGGER` runs on the
  **shared** table — for a BYOD org this is wrong + globally destructive; must be org-guarded or no-op.

### 3b. Vector bypasses (would read/write central Qdrant)
- **18 direct `fetch(QDRANT_URL)` sites:** `server.js:1578` `storeVector` (knowledge entity vectors —
  **HIGH**, writes central Qdrant not `.amr`), all delete paths (`server.js` ×7, `cognition-loop.js`,
  `orphan-pruner.js`, `control-plane-server.js:853` drop-collection), `persona-vector.js` (the
  `profile_<orgId>` collection — **not routed at all**, persona vectors orphaned on BYOD),
  `ingestion/indexer.js` legacy fallback. **Fix:** route every write through `qdrantClient.storeMemory`
  (which already calls `isMnemeOrg`), add `amrDelete(orgId,...)` to the driver and route every delete
  through it, and route persona vectors through the driver (or fold into the main memory layer).

### 3c. Cross-service bypasses (other services touch the central DB directly)
- **`employees-service` (Python) opens its OWN asyncpg pool + Redis** (static `DATABASE_URL`/
  `REDIS_URL`, not per-org) — a BYOD org's HyperAgents/employee data hits the **central** PG/Redis.
  **Fix:** the Python service must NOT hold a tenant DB connection. Route its tenant reads/writes
  through hm-core's HTTP API (the seam), OR give it a per-org connection resolver that, for a BYOD org,
  proxies through the engine's remote driver. (This is the biggest structural item.)

### 3d. On-disk residency leaks (tenant content on OUR disk)
8 sites write tenant content to the central box: `kb-ingest-queue.js` → `/app/data/kb-store/<org>/…`
(uploaded files), `server.js` → `/tmp/hivemind-docling/` (extracted PDF text, **not org-scoped**),
`audit/export.js` → `/tmp/audit-export-*`, `server.js` → `/tmp/hivemind-chrome-*.zip`, WhatsApp
sessions (`userId`-scoped, no `orgId`), `web-job-store.json`, `mcp-connectors.json`. **Fix for BYOD:**
the data plane (uploads, scratch, docling temp) must live on the **customer box** — either the agent
accepts the upload and parses locally, or these writes are encrypted-at-rest + purged-after-use and the
**source content never persists** on our disk. Scope every path by `orgId`; purge on completion.

---

## 4. Adversarial leak enumeration (every way data still leaks → mitigation)

| # | Leak vector | Mitigation |
|---|-------------|------------|
| 1 | **LLM egress** (distill/entity/synthesis/conflict) — raw text → Groq/OpenRouter | T1: customer-supplied keys (their egress) + opt-in. T2: local LLM. |
| 2 | **Audio egress** — raw meeting audio → Groq Whisper + pyannote.ai | Opt-in; T2: local Whisper + local pyannote (GPU). |
| 3 | **Vision egress** — PDF/image base64 → Groq vision | Opt-in; default docling-local; T2: local vision model. |
| 4 | **Embedding egress** — memory text → LiteLLM/OpenRouter | Localise: BGE-M3/ONNX on the agent or central (text still transits central in T1). |
| 5 | **Raw-SQL bypass** → central Postgres (§3a) | ORM-ify + fail-loud for BYOD orgs. |
| 6 | **Direct-Qdrant bypass** → central Qdrant (§3b) | Route through driver; add `amrDelete`. |
| 7 | **employees-service direct DB** → central PG/Redis (§3c) | No tenant DB conn in the Python service; proxy via seam. |
| 8 | **On-disk scratch** — uploads/docling/exports on our `/tmp` & `/app/data` (§3d) | Parse on the agent; else encrypt-at-rest + purge; org-scope all paths. |
| 9 | **Logs** — recall/ingest logs print content snippets, IDs, org_ids | Structured logging with content redaction for BYOD orgs; no raw text in logs. |
| 10 | **Error payloads** — Prisma/Qdrant errors echo row/query data (we saw it in this very build) | Sanitise errors before logging/returning; never echo row contents. |
| 11 | **Cross-org query** — a missing `orgId` filter returns another tenant's data | The driver's per-call org routing + the conformance gate; add a tenant-isolation test that asserts no cross-org read. |
| 12 | **Backups** — central `.amr`/PG backups contain BYOD data | BYOD data is NOT on our box (it's on theirs); ensure no central backup of a remote org. |
| 13 | **Caches** — recall/embedding caches hold content centrally | Per-org cache keys; TTL; no content in a shared cache for BYOD. |
| 14 | **Nango / connector content** — Gmail/Drive bodies normalised → memories | For BYOD, the normalised memory must land in the customer store (via the remote driver), not central. |
| 15 | **Version skew** — central engine vs customer agent protocol drift | Versioned tunnel protocol; agent reports version; engine refuses incompatible; auto-update channel. |
| 16 | **Stolen pasted key** | Layered identity (§1): short-lived enrollment token bound to a per-tenant mTLS cert; dashboard revoke. |

**Honest verdict:** #1–#4 are the residency wall — **unavoidable in T1 without local inference**. The
clean T1 product is: *"your stored memory lives on your box; processing uses YOUR LLM keys (your
egress), opt-in for audio/vision, and we never persist your raw content on our disk."* T2 closes
#1–#4 with on-prem inference.

---

## 5. Security model
- **Transport:** outbound-only from customer; mTLS (per-tenant client cert); E2E (own agent or
  WireGuard); destination locked server-side per tenant.
- **Identity:** enrollment token (short-lived, single-use) → per-tenant cert; token bound to cert
  (RFC 8705/DPoP). Key scope = one org. Rotation + instant revoke from dashboard.
- **Isolation:** the agent can reach only its own data endpoint; the broker maps `tenant_id → tunnel`;
  no agent can address another tenant or our internal hosts.
- **At rest:** customer's disk + their encryption; in transit: TLS; central box holds **no** BYOD data.
- **Audit:** connection events, key rotations, query counts surfaced to the customer's dashboard.

---

## 6. Build order
1. **Foundation (needed regardless):** `infra/docker-compose.yml` + `setup.sh` → reproduce prod on a
   fresh Hetzner in one command (the new-box deploy + the base for the BYOD customer repo).
2. **Seam hardening (P0 for BYOD correctness):** fix §3a compliance bypasses + the `ALTER TABLE
   DISABLE TRIGGER`; add `amrDelete` + route the 18 Qdrant bypasses; ORM-ify or fail-loud the raw-SQL
   memory path; tenant-isolation conformance test.
3. **Remote driver + agent:** the 4th driver mode (`remote`) + the `hm-agent` (outbound mTLS tunnel +
   local store executor) + the broker on our side.
4. **`employees-service` deglobalise:** remove its tenant DB connection; proxy via the seam.
5. **Disk residency:** move uploads/docling/scratch to the agent or encrypt+purge centrally.
6. **Provider-keys (T1 egress):** per-org LLM/embedding/STT/vision keys → customer's egress; opt-in
   audio/vision; egress disclosure in onboarding.
7. **`hivemind-byod` customer repo:** compose (their `.amr` *or* PG+Qdrant + `hm-agent`) + `setup.sh` +
   paste-key flow + dashboard connection status.
8. **T2 (optional enterprise):** local-inference profile (Ollama/vLLM, Whisper, pyannote, embeddings).

---

## 7. The `.amr` advantage for BYOD (stated plainly)
- **`.amr`-BYOD** = the customer hosts **one file + the agent**. No Postgres, no Qdrant, no DB ops, no
  3-system backup. `setup.sh` is `docker run hm-agent -v ./data/<org>.amr`. This is the self-host
  story Postgres can't match — it's why the format exists.
- **hybrid-BYOD** still works (they run PG+Qdrant) for customers who want it — same agent, same remote
  driver. The driver makes the two indistinguishable to every feature.

---

## 8. Bottom line for the roadmap
- **Storage residency (T1):** real, weeks away — driver + agent + close the seam bypasses (§3).
- **Egress residency (T2):** needs on-prem inference or customer-supplied keys — the honest line to
  customers is "your data is stored on your box; processing uses your provider keys (your egress)".
- **The biggest hidden work is not the tunnel — it's closing the bypasses** (§3): 12 stray Prisma
  clients, ~16 raw-SQL memory paths, 18 direct-Qdrant calls, the Python service's own DB connection,
  and 8 on-disk leaks. Until those route through the seam (or fail loud), "no data leaking" is not true.

---

## 9. Failure-mode + operational gaps the plan MUST close (adversarial review)

The sections above cover *storage routing* and *egress*. The other half — *failure-mode engineering*
— is where a BYOD product loses data or silently breaks. Each gap below has a one-line fix. **P0 = data
loss / leak / broken product.**

### ⚠️ G2 is a CURRENT bug, not just BYOD
The proxy (`prisma-proxy.js`) passes **`$queryRaw*` straight through to central Postgres**. But
`prisma-graph-store.js:~733` `searchMemories()` — **the lexical/FTS leg of every hybrid recall** — and
the **Postgres advisory locks** (`profile-store.js`, `profile-dreamer.js`, `cognition-loop.js`
synthesis, `acquire_memory_user_lock`) are raw SQL. So **for the live sai/`.amr` org (PG=0) the FTS leg
already returns empty and the advisory locks lock a DB the data isn't in** — degraded recall + no mutual
exclusion, *today*, and the conformance gate is GREEN because it never tests `$queryRaw`. **Fix now:**
intercept `$queryRaw*` in the proxy for `.amr`/remote orgs → route FTS to the `.amr` text search or
throw `MnemeUnsupported`; replace PG advisory locks with a store-agnostic lock (Redis/agent); add a
conformance case asserting raw SQL never reaches central PG for a BYOD org.

### P0
- **G1 — Migration (DATA LOSS):** no procedure to move an org's existing 1000s of memories from central
  PG+Qdrant to `.amr`/remote; today's de-facto path is "ingest then wipe PG" (no dual-write, no
  reconcile, no rollback). *Fix:* 5-phase migration — dual-write → backfill copy → row-count+checksum
  reconcile → read-cutover → delete source only after a verified backup; reversible at each phase.
- **G3 — Non-atomic remote write (CORRUPTION):** `driver.js storeMemoryUnified` upserts the memory then
  loops `relationship.create()` — not a transaction. Over a tunnel a mid-loop drop leaves a memory with
  half its edges / no vector. *Fix:* one transactional RPC the agent applies atomically on the box +
  idempotency key + replay log; never stream sub-writes across the tunnel.
- **G4 — Disaster recovery:** the customer holds the ONLY copy; no agent-enforced backups / integrity
  check / restore. *Fix:* agent enforces scheduled atomic `.amr` snapshots (under the flock) to a
  customer target, exposes restore + verify; dashboard refuses "healthy" with no recent backup.
- **G5 — Multi-replica fan-in:** prod runs hm-core + hm-core-2 (both write); `.amr` is single-writer.
  Two tunnels to one agent = flock contention / lost writes. *Fix:* elect one writer per BYOD org
  (advisory-lock / queue-affinity); other replica proxies through it or is read-only.
- **G6 — Advisory locks no-op on BYOD** (same mechanism as G2): synthesis/dream/ingest lose mutual
  exclusion → races + double-writes. *Fix:* store-agnostic lock (Redis/agent), asserted in the gate.

### P1
- **G7 — Tunnel-drop semantics:** no queue/retry/backpressure/UI state defined. *Fix:* recall fails fast
  with a typed "store unreachable" (never silent stale); ingest durably client-queued with bounded
  retry; dashboard shows tunnel state + queue depth.
- **G8 — N+1 over the wire:** recall fans out 7–12 sub-queries (lexical + base/entity/temporal vector +
  relationships + profile + per-candidate graph expansion); dreaming loops per-cluster (~55/tick). At
  100 ms RTT a recall adds ~1 s; a dream tick adds tens of seconds. *Fix:* a coarse "recall bundle" RPC —
  the agent runs the whole multi-leg recall locally, returns ranked results in ONE round-trip; batch the
  per-cluster loops before they ever cross a tunnel.
- **G9 — Broker is a new SPOF:** no HA / capacity / observability. *Fix:* ≥2 broker instances + shared
  tunnel registry, per-tenant health metrics to both dashboards, availability SLO.
- **G10 — `ALTER TABLE memories DISABLE TRIGGER` on the shared table** (account delete) is globally
  destructive + unreachable for BYOD. *Fix:* org-guard to no-op for BYOD; app-level soft-delete via the
  agent.
- **G11 — Engine blindly trusts agent responses:** a compromised agent can return forged `orgId`s /
  poisoned facts / colliding IDs that enter ranking + dreaming. *Fix:* validate every agent response
  server-side — assert each row's tenant == the tunnel's locked tenant, namespace BYOD IDs to prevent
  collision, treat agent output as untrusted (schema + bound checks).
- **G12 — Auth lifecycle:** enrollment-token replay (atomic single-use burn), cert expiry mid-session
  (graceful re-handshake without dropping queued writes), clock-skew window + NTP guidance — all
  unspecified. *Fix:* specify each.

### P2
- **G13 — Agent versioning/rollout:** no signed-artifact + staged-rollout + per-tenant pin + protocol-
  incompatibility refusal. *Fix:* add the channel; a bad push to customer boxes is otherwise
  unrecoverable.
- **G14 — Opt-in egress must fail CLOSED:** a BYOD org without audio opted-in must *block* the Groq
  Whisper call, not merely "document it". *Fix:* hard-fail-closed flags; size the T2 GPU SKU before
  selling it.

**Revised bottom line:** the seam/egress audit is necessary but not sufficient. **G2 is live today**
(FTS + advisory locks bypass to central PG for the `.amr` org — fix it regardless of BYOD). Migration
(G1), atomic remote writes (G3), DR (G4), single-writer-vs-2-replicas (G5/G6), tunnel-drop (G7), wire
N+1 (G8), and trusting agent results (G11) are the failure-mode work that turns this from a demo into a
product.
