# STRATEGY — What's Solid, What's Fragile, and the 24/7 Hardening Plan

> Read after the 9 subsystem docs. This is the forward plan: a strategic read of
> the last 7 days' work + a concrete plan to use idle Claude Code budget to harden
> the repo autonomously **without breaking the live system**.

---

## 1. Strategic read — where the foundation stands

### Solid (shipped, flag-gated, dark-safe)
- **Security** — PQC TLS + ML-DSA memory signing + SLH-DSA append-only audit
  chain. Strongest layer; defense-in-depth, env-only keys. ✅
- **Memory engine reliability** — P2010 crash class (surrogates/NUL/JSONB/tx-
  timeout) fixed. Salience loop now real. ✅
- **Cognition token-bleed** — Faraday signal-gate + cheap writer model stopped the
  1M-token/day exhaustion that was silently killing ALL governance cycles. ✅
- **Self-evolving retrieval** — closed control loop with a **verify gate that
  cannot regress Recall@K**. Architecturally the most important win. Currently dark
  (`EVOLUTION_ENABLED=false`). ✅ design / ⚠️ unproven in prod.

### Fragile / unproven (the real risk surface)
1. **Canonical ingestion is ASSUMED working, not PROVEN.** The user's core
   requirement: KB ingestion + character ingestion + MCP `save_memory` ALL route
   through one `createMemory` and create relations. This needs a **cold end-to-end
   test per path**, not a code read. ← highest priority.
2. **Recall robustness is unmeasured in prod.** Top-5 delivery, score_threshold,
   salience boost — all shipped, but no standing Recall@K baseline running against
   live data. The eval harness exists (`eval-harness.mjs`, 14 cases) but isn't scheduled.
3. **bge-m3 1024 cutover is half-done.** Embed factory + per-org containers wired
   but dark. A botched flip = recall blackout. Needs a staged, reversible cutover test.
4. **Evolution loop never ran live.** `EVOLUTION_ENABLED=false`. The verify gate is
   the safety net but it's never fired against production org data.
5. **HyperAgents 18s latency + hallucination** — fix designed (shared-blackboard
   pre-RAG + lead-first), not implemented.
6. **AI Meeting Notes** — functional backend, weak UI. User wants full redesign.

### The governing constraint
**LIVE system, real users.** Every autonomous run must be: read-only by default,
write only behind a verify-and-revert gate, and never touch a shared prod path
without a cold test proving no regression first.

---

## 2. Cold tests (NOT hypothetical) — the definition

A **cold test** = a real request against the live (or a prod-mirror) stack, with a
real user/org, asserting on real DB + Qdrant + graph state. No mocks. The canonical
test user/org from the apex skill:
```
USER_ID=54f5568b-4d6a-4ae1-9a33-48cb2909d59b   # amarsai2005@gmail.com
ORG_ID =67503d34-97e9-49a8-8c52-8ee30cc7603e
```
Never use `MASTER_API_KEY` to emulate a user — pass `X-HM-User-Id` + `X-HM-Org-Id`.

### Cold-test suites to build (in priority order)
| # | Suite | Asserts |
|---|-------|---------|
| T1 | **Canonical ingestion parity** | Ingest the same fact via (a) KB upload, (b) character ingest, (c) MCP `save_memory`, (d) direct `/api/memories`. All 4 → a `source_metadata` row, `ts:*` tags, `entity:*` tags, and ≥1 relationship edge. Assert all 4 paths produce structurally identical graph shape. |
| T2 | **Recall@K baseline** | Run `eval-harness.mjs` (14 golden cases) hourly; record Recall@K + p95. Alert on regression vs rolling baseline. |
| T3 | **Relationship integrity** | After ingest, assert entity-co-mention edges + no cascade explosion (is_latest=false count < 3× is_latest=true). |
| T4 | **PQC verify** | `/api/security/verify-memory` + `/audit-verify` return valid for fresh writes + the audit chain has no tail regression. |
| T5 | **Cognition cycle dry-run** | Trigger one governance cycle on a sandbox org; assert Faraday gate fires, writer uses cheap model, bridges are entity-grounded. |
| T6 | **HyperAgents turn** | POST a room turn; assert it seals < N seconds with ≥1 prose line and no raw JSON leak. |

---

## 3. The 24/7 autonomous hardening plan

Three tiers, escalating risk. **Tier 1 runs unattended. Tier 2/3 gate on Tier 1 green.**

### Tier 1 — Continuous verification (READ-ONLY, safe to run unattended)
Scheduled every 1–2h. Pure observation, zero writes to shared prod paths.
- Run T2 (Recall@K), T4 (PQC verify), T6 (HyperAgents smoke) against live.
- Run T1/T3 against the **canonical test user only** (writes scoped to one test
  account, fully reversible).
- Emit a health report to a journal file + HIVEMIND memory tagged `nightly-health`.
- **Stop condition:** any regression → halt Tier 2/3, write a RED report, ping.

### Tier 2 — Gated improvements (WRITE behind verify-and-revert)
Runs only when the latest Tier 1 report is GREEN. One improvement per run, each
on its own branch, each verified before merge:
- Fix one known-open item from §1 (canonical-ingestion edge cases, recall tuning).
- Implement HyperAgents shared-blackboard pre-RAG (flag-gated, default off).
- Each run = the De-Sloppify pattern: implement → cold-test → code-review subagent
  → commit only if green. Never auto-deploy to prod; stage on branch + report diff.

### Tier 3 — Larger features (human review at merge)
- AI Meeting Notes redesign (frontend-design skill).
- bge-m3 1024 staged cutover rehearsal (on a sandbox org/collection first).
- Evolution loop live-enable rehearsal (dark → shadow-mode → enable, each gated).

---

## 4. Mechanism — how to schedule it

Three viable harness options (from the autonomous-loops skill):

| Option | Fit | Notes |
|--------|-----|-------|
| **`/loop` dynamic mode** (ScheduleWakeup) | Best for THIS session's 12h window | Re-fires the same task on a cadence; I self-pace. Survives across turns. |
| **Cron scheduled task** (`scheduled-tasks` MCP / CronCreate) | Best for true 24/7 beyond this session | Fires independent of any open session. |
| **Continuous-Claude PR loop** | Best for Tier 2/3 (branch+CI+merge) | `--max-duration 12h --max-cost $X`, SHARED_TASK_NOTES.md for cross-iteration memory. |

**Recommended:** Cron (`scheduled-tasks`) for Tier 1 health checks (must outlive
the session) + a `/loop` or continuous-claude run for Tier 2 improvements during
the 12h window, gated on the latest Tier 1 report.

---

## 5. Immediate next actions (pending user go-decision)
1. Build the T1–T6 cold-test scripts under `core/scripts/cold-tests/` (read-mostly).
2. Wire a single `nightly-health.mjs` orchestrator that runs T1–T6 and writes a report.
3. Register the Tier-1 cron (cadence TBD with user).
4. Kick the Tier-2 loop scoped to the highest-value open item (canonical-ingestion
   proof, then HyperAgents pre-RAG).

**Open decision for the user:** cadence + how much write-autonomy Tier 2 gets
against the live system (branch-only vs auto-deploy-on-green).
