# mneme / `.amr` — Roadmap (two-tier wedge)

> Strategy: ship the narrow thing (embedded vector store) to win adoption, let adoption GATE the
> hard thing (single-file memory engine). The `.amr` file is a superset — Tier-1 files become
> Tier-2 capable by adding fields, never a rewrite. Frame: **"SQLite for agent memory"**, NOT
> "Qdrant replacement." Real competitor is **LanceDB** (embedded), not Qdrant (server).

---

## Current production state (do not regress)

- `singulance-amr@0.1.0` published on npm (macOS arm64). Public repo `github.com/amar3012005/mneme`.
- LIVE in HIVEMIND production: org `723f0f5b` (sai@bundb.de) served by `.amr`; **only that org**.
  All other 13 orgs on Qdrant, byte-identical. Verified: routing isolated, recall 5/5 self-top1,
  storage 2.0M vs 23M (11.5×), recall p50 1.16ms vs 1.50ms, parity (upsert-replace/delete/
  score_threshold) live. Kill switch = `core/data/mneme/enabled-orgs`.
- **Pinned: sai stays on `.amr`. Do not enable another prod org without a deliberate decision.**

---

## TIER 1 — the wedge: "SQLite for agent memory" (embedded vector store)

Goal: a *real product* people embed, not a demo. This is the asset that gates everything else.

- [ ] T1-1: **Multi-OS publish.** Set a Granular/Automation npm token as the GH `NPM_TOKEN` secret →
      tag → CI publishes linux-x64/arm64 + win-x64 + mac sub-packages. `npm i singulance-amr` works
      on every OS, zero toolchain. (Builds already pass in CI; only the token blocks it.)
- [ ] T1-2: **Stable public API + types.** Freeze `MnemeVectorStore` (upsert/search/delete/compact)
      + `.d.ts`. Semver. Document the `.amr` format as an RFC (SPEC.md is the seed).
- [ ] T1-3: **Filtering parity.** score_threshold (done) + payload field filters + metric choice.
      Enough that an embedder isn't forced back to a server for a basic WHERE.
- [ ] T1-4: **The killer benchmark — vs LanceDB, not Qdrant.** Same corpus, embedded-to-embedded:
      storage, recall@10, p50/p99, cold-open time. Publish it. (Honest: include where we lose.)
- [ ] T1-5: **Node-binding latency.** Today the napi path is slower than the Rust engine at scale
      (4ms @ 8k). Trim it (narrower ef path / avoid Float32Array re-marshalling) so the embedded
      win holds past ~10k vectors. Target: binding p50 within 1.5× of native.
- [ ] T1-6: **Docs + 3 quickstarts** (Node, CLI, "replace your local Chroma/LanceDB in 5 lines").

### ADOPTION GATE (hard, 60-day)
> The memory engine is the prize; adoption of the wedge is the gate. Do NOT start Tier 2 until:
- [ ] **≥5 real teams** embedding `singulance-amr` who are not us, OR
- [ ] meaningful OSS pull (stars/issues/forks from strangers) on the "SQLite for agent memory" line.
- If the gate does NOT open in 60 days → the platform dream is a fantasy; stop, and sell the 11×
  embedded vector store as what it is. (We still have a good product.)

---

## TIER 2 — the prize: single-file memory engine (GATED on Tier-1 adoption)

Goal: `.amr` holds the WHOLE memory — not vectors. Then a company's brain is **one file**:
encryptable, movable, auditable, sovereign. Collapses Postgres + Qdrant + Redis → one mmap.
This is the only 10x no *server* DB can follow us into.

- [ ] T2-PROBE (the make-or-break, ~1 week, run BEFORE committing Tier 2):
      Extend the slot: typed-edge adjacency `{type, weight, target}` (replace 8 untyped pointers)
      + bi-temporal version chains (supersede in-place, native `is_latest`). Then ONE test:
      **a 2-hop *typed* traversal + a "what did we know on date X" version query, served from a
      single mmap, matching Postgres' answer.**
      - PASS → it's the first single-file memory engine; we kill a database. Build to production.
      - FAIL (graph mutation + versioning in a memory-mapped append-only file is genuinely hard —
        that IS the real physics) → ship Tier 1 as a vector format, stop calling it a memory engine.
- [ ] T2-1..n: only specced if the probe passes. (typed edges, version queries, entity table,
      encryption-at-rest as the sovereignty artifact, then HIVEMIND collapses Qdrant→.amr org-wide.)

---

## Kill conditions (the whole thesis)
1. **Building Tier 1 + Tier 2 in parallel** → ship two 60%-done things, lose to focused comps. Sequence.
2. **Positioning as "Qdrant replacement"** → feature war on a server's turf, we have 5% of the surface, we lose. Frame embedded.
3. **`.amr` stays vectors-only** → we built a faster Qdrant shard the world already has. The probe (T2-PROBE) is the fork between revolution and forgettable optimization.

## Next move (this week)
T1-1 (multi-OS publish — token-gated) + T1-4 (LanceDB benchmark). Cheapest path to the adoption gate.
