# The Governance Loop

How a task moves through the crew. One pass = one accountable unit of work.

## Phases
### 0. INTAKE (driver)
- State the task in one line. Classify: `setup` | `bug` | `feature`.
- Pull context: `git log`, the relevant `journals/*`, `JOURNAL-CHANGELOG.md`, and HIVEMIND memory.

### 1. ARCHITECT — plan + seam-check
- Recon FIRST: does 80% already exist? (graph/grep/prod). Reuse over rebuild.
- Produce the **minimal** change: which ONE seam, which flag, why additive.
- Reject scope creep + new tables/branches-on-backend. Output: a bounded step list + the rollback.
- Journal: the decision + what was rejected + the kill-condition.

### 2. BUILDER — implement
- Additive + flag-gated only. Default path unchanged. No edits to the hot path without a note.
- Captured clients → context proxy (never resolve-at-construction).
- Syntax-check + the local unit/isolation test BEFORE handing off.
- Journal: files touched, the flag, the local test result (verbatim).

### 3. VERIFIER — prove it on the real box
- Deploy to the box (or run against it). Run:
  - the **isolation test** (managed org → central; new behavior → only when flagged),
  - a **live smoke** (real request, real output),
  - the **managed-unaffected gate** (a known managed flow still works).
- RED on any → **rollback + back to ARCHITECT**. GREEN → pass to SCRIBE with the evidence.
- Journal: each test + verbatim output + GREEN/RED + (if RED) the rollback.

### 4. SCRIBE — record
- Append each agent's journal entry. Roll the turn into `JOURNAL-CHANGELOG.md`:
  date · task · commits · deployed? · inert/active? · verified-how · residuals.
- Journal: the one-line accountable summary.

## Gates between phases (must pass to advance)
- ARCHITECT→BUILDER: change is additive + flag-gated + reuses existing? else re-plan.
- BUILDER→VERIFIER: syntax clean + local test green + default path untouched? else fix.
- VERIFIER→SCRIBE: real-box smoke green + managed unaffected? else rollback.

## Anti-patterns the loop kills (observed)
- "It should work" without a real-box smoke. → VERIFIER blocks.
- A new table/branch for what's already a memory/layer. → ARCHITECT rejects.
- Capturing `getPrismaClient()` at construction. → BUILDER uses the context proxy.
- Green unit tests masking a wrong-store bug. → VERIFIER's managed gate catches it.
- Hand-writing what `pg_dump`/an existing migration gives. → ARCHITECT's reuse rule.

## Anti-patterns the loop killed (2026-06-27, Phase 2b)
- Skipping the central `createMemory` for a residency org WITHOUT pushing the row somewhere readable
  first. → mid-ingest reads (applyExtends/versions → getMemory) find the row NOWHERE → ingest throws.
  FIX/RULE: for an agent-org, `createMemory` must PUSH the row to the agent immediately (vector added
  later by the storeMemory same-id upsert) so mid-ingest reads resolve on the agent. Never leave a
  freshly-created memory unreadable between create and the vector-store step.
- A residency write-skip that forgets the FK CHILDREN (sourceMetadata/version/relationship) → P2003
  against the absent central parent. RULE: gate the whole subgraph together (A2), not just `memory`.
- Registry left with a stale `pgUrl` → engine silently revives the dead direct-PG path. RULE: push
  model = `{url, token}` only; assert pgUrl empty.
