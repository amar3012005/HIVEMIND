# The Feature Loop — how I harden one feature for Enterprise B2B production

My standing operating protocol. One feature at a time, FE→backend→failure-modes→
performance→fix→e2e, until it demonstrably works in the browser. Then the next.

I do not ask which feature. I take the top unchecked entry in `GOALS.md`,
work it to done, mark it, and continue. The queue is the instruction.

---

## The seven steps, in order

### 1. FE FIRST — what does the user actually see?
Open the page component before any backend file. Read the whole thing.
- Which endpoints does it call? (resolve every `apiClient.<method>()` against
  `shared/api-client.js` — do not guess from the page name)
- What does it render on **empty**, on **error**, on **slow**? A feature that
  renders a spinner forever on a 500 is broken even if the API is perfect.
- What does it do with a **partial** response — half the fields missing?
- Is there a mobile variant? It is a *different component* and usually staler.

**Output:** the endpoint list, written into `.claude/features/<slug>.md`.

### 2. BACKEND — trace it to storage, not to the handler
Follow each endpoint to the row it writes or reads. Stop only at the table,
the Qdrant collection, or the `.amr` file.
- Which service — core `:2026` or control-plane `:2027`? Control proxies via
  `/v1/proxy/*`; the real logic is almost always in core.
- **Which storage backend?** `organizations.memory_storage_mode` splits tenants:
  `hybrid` → Postgres, `amr_embedded`/`byod_amr` → `.amr` at
  `/app/data/mneme/<orgId>/`. Roughly half of live tenants are NOT in Postgres.
  A Postgres-only check reports a confident FAIL for a perfect ingest.
- Read the actual column list before writing raw SQL. Inventing a column that
  "should" exist is how I 42703'd the scheduler in production for four minutes.

### 3. THINK LIKE AN ENTERPRISE B2B TENANT — what fails at their scale?
Not "does it work". **Who does it hurt, and how would they discover it?**

Run this list against every feature. Each is a defect I have actually found here:

| failure mode | the question to ask |
|---|---|
| **Cross-tenant leak** | Can org A's scoped key see org B's row? Prove it with TWO real keys and a set intersection — not by reading the WHERE clause. |
| **Success-shaped empty** | Does a broken dependency return `200 []`? An empty result is indistinguishable from "no data" and is the single most expensive bug class here — it wasted a day on `/api/recall` and on the empty-upload path. |
| **Silent partial** | Does a half-finished pipeline report `✓`? A document with zero memories was logged as `indexed`. |
| **Unbounded input** | 0 bytes, 1 byte, 60 MB, wrong MIME, encrypted, 10k rows. What is the *reject* path, and does it say something the user can act on? |
| **Unbounded output** | Does a 10k-memory org get a 40 MB JSON with no pagination? |
| **Idempotency** | Retry the same call. Double-write? What about a crash *mid*-pipeline? |
| **AuthZ, not just authN** | Unauthenticated is easy. Test **authenticated-but-wrong-org** and **member-vs-admin**. |
| **Plan enforcement** | Is `plan-enforcer.checkLimit` actually called on the path that consumes quota, or only defined? |
| **Observability** | If this silently degrades, how does anyone find out without SQL? |
| **Blast radius** | Does one tenant's pathological input degrade the others? Shared queue, shared budget, shared connection pool. |

**Write the answers down with evidence.** "Probably fine" is not an answer.

### 4. MEASURE — curl it, don't reason about it
Constraints are found with a stopwatch, not by reading code.
- Cold and warm latency for every endpoint the page calls on load.
- The page's **total** load cost: 12 endpoints × 300 ms serial is a 4 s page.
- Latency at real data volume — the 155-memory org, not the empty one.
- Find the ONE slowest thing. That is the constraint. Fix it. Re-measure.
  Then find the new one. Do not optimise anything else.

Record real numbers. `/api/recall` 0.26–0.82 s warm, `/api/chat` 1.7–2.1 s
end-to-end are the current bars; a regression against them is a defect.

### 5. FIX — modify what exists
**Non-negotiable, in priority order:**
1. **Modify the existing function.** The behaviour is nearly always already
   there, disabled, mis-defaulted, or unreachable. Four of this session's real
   fixes were a wrong default, a dead `if`, an unimplemented comment, and a
   `||` in the wrong order. None needed new code.
2. **Never add a second way to do the same thing.** A parallel path is worse
   than the bug — now both are half-maintained. Before writing any new file,
   grep for the capability. Use the `feature-recon` skill.
3. **No patch on top of a patch.** If the fix is a special case guarding a
   special case, the layer below is wrong. Fix that instead.
4. **Fix the cause.** If a probe returns nothing, the bug may be the probe.
   Eleven times this session the "defect" was my own test.

### 6. VERIFY E2E — in the browser, not in psql
The feature is not done until the **page** shows the right thing.
- Re-run the reproduction command; it must pass from a clean state.
- Load the actual FE route and confirm the rendered result.
- Check all three live orgs, including the **0-memory** one — empty state is
  where features break.
- Re-run the canary. Green means no regression, not success.

### 7. RECORD, THEN NEXT
Update `.claude/features/<slug>.md`: every guardrail VERIFIED or MISSING **with
the evidence**, the reproduction command, and what is still open. Commit with a
message that says what was broken and how it was proven. Mark the goal `[x]`.
Move to the next one **without asking**.

---

## Rules I keep breaking, so they live here

- **The auth contract.** core `:2026` = scoped API key. control-plane `:2027` =
  `Authorization: Bearer <sessionId>`. `X-Org-Id`/`X-User-Id` are CORS entries,
  **not auth**; `X-Emulate-Org` does not exist. A probe using them runs
  UNSCOPED and returns empty results that look exactly like a broken feature.
  This produced **eight** false bug reports in one session.
- **Check `created_at` before calling a zero a defect.** Most zero-counts here
  are historical data, not current behaviour.
- **Verify "X is missing" against running code before reporting it.** Five such
  claims were wrong: the code existed and worked.
- **My own test is the first suspect.** Duplicate fixtures measured dedup, not
  capture. A Postgres query measured the wrong backend. A hand-written header
  measured nothing at all.
- **Other sessions redeploy this box.** A `docker cp` can be silently reverted
  mid-task. Re-grep the *container* for a marker string before concluding a fix
  didn't work.
- **Build in `/root/hivemind-main`, deploy from `/root/hivemind`.** Absolute
  paths always — a relative `-f` hit the wrong compose file once already.
- **Tag the rollback image BEFORE any deploy.**
- **Report failures with the output.** If it isn't verified, say so plainly.
  A hedge is worse than a red result, because a red result is actionable.
