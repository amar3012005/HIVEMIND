# HIVEMIND — the operating loop

Full engineering context lives in `AGENTS.md`. This file is the **loop**: how work
is sequenced, and what "done" means before anything moves forward.

## The loop

Work the queue in `.claude/loop/GOALS.md` **top to bottom, one feature at a time.**
For each feature, run `.claude/loop/FEATURE-LOOP.md` (FE → backend-to-storage →
enterprise failure modes → measure with curl → fix by MODIFYING existing code →
verify e2e in the browser). Then, and only then:

### Gate 1 — E2E, not "the API works"
The feature is done when the **page** shows the right thing for a real user, on
all three live orgs including the 0-memory one. A green curl is not e2e. A passing
unit test is not e2e. Re-run the feature's reproduction command from a clean state
and watch it pass.

### Gate 2 — SECURITY REVIEW, every feature, no exceptions
Before a feature is marked `[x]`, run a security review over what it touches.
Minimum coverage, each answered **with evidence, not reasoning**:
- **Tenant isolation** — prove with TWO real scoped keys and a set intersection
  that org A cannot see org B's rows. Never by reading a `WHERE` clause.
- **AuthZ** — unauthenticated, *authenticated-but-wrong-org*, and member-vs-admin.
  The middle one is the one that actually leaks.
- **Input validation** — 0 bytes, huge, wrong MIME, corrupt, encrypted. What is
  the reject path, and does it tell the user something actionable?
- **Secrets** — nothing server-side reaches a browser (the `x-tara-key` lesson).
- **Injection / SSRF** — anywhere a URL, query, or path comes from a user or agent.
- **Quota** — is the limit *called* on the consuming path, or merely defined?

A feature that has not been security-reviewed is **not done**, even if it works
perfectly. Do not advance the queue.

### Gate 3 — LEFT.MD, the accountability gate
If ANYTHING is left unfinished, write `.claude/features/<slug>.left.md` **before**
moving on. Not a TODO list — an accountability record. Each entry states:

```
## <what is not done>
**Evidence:** the log line, query result, or measurement proving it is real
**Why it was left:** the honest reason — blocked, out of context, needs owner
                     approval, requires a capacity decision. "Ran out of context"
                     is acceptable; vagueness is not.
**Who it hurts:** the concrete production consequence for a real tenant
**Next step:** the specific first action, precise enough to start cold
```

Then say the same thing in the chat reply. **Silent partial completion is the one
unforgivable failure** — it is exactly the shape of every defect this codebase has
produced (a document logged `indexed` with zero memories; a fixture that measured
dedup instead of capture; `200 []` from a broken dependency). Never let your own
work take that shape.

Only after Gates 1–3: commit, mark `[x]` in GOALS.md, and start the next feature
**without asking**.

## Non-negotiables

- **Modify existing code.** Nearly every real defect here has been a wrong default,
  a dead branch, an unimplemented comment, or a `||` in the wrong order — not
  missing code. Grep before writing; run `feature-recon` when unsure.
- **No second path.** A parallel implementation is worse than the bug. Delete the
  bypass, never leave it as a fallback.
- **No patch on a patch.** A special case guarding a special case means the layer
  below is wrong. Fix that instead.
- **Measure, don't reason.** Constraints come from curl and SQL. When code and
  memory disagree, the running code wins.
- **Your own test is the first suspect.** Eleven "production bugs" in one session
  were broken probes.
- **Auth contract** (full version in `.claude/loop/GOALS.md`): core `:2026` takes a
  scoped API key; control-plane `:2027` takes a session Bearer. `X-Org-Id` is CORS,
  not auth. Get this wrong and every probe returns a convincing empty result.
- **Deploy hygiene.** Build in `/root/hivemind-main`, run from `/root/hivemind`,
  absolute paths, tag the rollback image FIRST. A `docker cp` is temporary — bake
  it into an image before calling it shipped, or the next `compose up` erases it.
- **Report failures with the output.** State plainly what is unverified.
