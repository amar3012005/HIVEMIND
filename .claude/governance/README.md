# HIVEMIND Governance Crew

A 4-agent loop for setting up, debugging, and evolving HIVEMIND — distilled from the real failure
modes hit while building the `.amr` engine + per-org data residency.

## The crew
| agent | role | the lesson it embodies |
|-------|------|------------------------|
| **architect** | designs the minimal change; guards the seam | over-engineering kills (the sidecar-table / `userProfile`-as-row mistake) — one seam, no feature branches on backend, reuse prod over rebuild |
| **builder** | implements exactly the plan; additive + flag-gated | capture clients via a context proxy, not at construction (the split-brain); never touch the hot path silently |
| **verifier** | tests on the REAL box; rolls back on RED | unit-green ≠ prod-safe (conformance was green while FTS hit the wrong store) — managed-unaffected gate, no fake success |
| **scribe** | journals every step; owns the changelog | accountability — what was tried, what broke, what's deployed, what's inert |

## The loop
```
ARCHITECT (plan, seam-check) ─► BUILDER (additive, flag-gated) ─► VERIFIER (real-box, managed-gate)
        ▲                                                                       │
        └────────────── SCRIBE (journal each + collective changelog) ◄──────────┘
```
On VERIFIER **RED → back to ARCHITECT**, not forward.

## Hard gates (non-negotiable, from scar tissue)
1. **Prod-safe**: every change additive + flag-gated; default behavior unchanged; managed orgs untouched.
2. **Verify on the real box**: isolation test + a live smoke; never "should work".
3. **No fake success**: failing test → say so with output; skipped step → say it.
4. **Reuse prod**: search for what exists before building (curated schema = `pg_dump` of prod, not hand-written).
5. **One seam**: backend-aware logic in ONE place; features never branch on the backend.

## How to run it
A driver (you, or the `loop` skill) walks a task through the phases, dispatching each agent with its
charter (`agents/<name>.md`). Each agent appends to `journals/<name>.journal.md`. The scribe rolls the
turn into `JOURNAL-CHANGELOG.md`. See `LOOP.md`.

## Files
- `LOOP.md` — phases, gates, handoffs.
- `agents/*.md` — each agent's charter + checklist + journal protocol.
- `journals/*.journal.md` — per-agent running log.
- `JOURNAL-CHANGELOG.md` — the collective, dated, accountable ledger.
