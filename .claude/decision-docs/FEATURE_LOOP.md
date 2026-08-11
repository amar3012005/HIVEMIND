# The Feature Loop — how work ships here

Every rule below exists because it was broken in this repo and cost real time or
real data. No generic advice: each gate cites the incident that created it.

---

## G0. RECON — find the layer that OWNS the truth

Before writing a line, locate where the fact you need already exists.

- **Incident:** `start_page` was null on every PDF. First fix added a form-feed
  fallback — a patch on the wrong layer. The parser *already* assigned a correct
  page to every chunk (`hybridChunks[].page`); segmentation was throwing it away
  and re-sniffing markers out of flattened text. Right fix: consume the parser's
  own data.
- **Incident:** MCP `hivemind_at` on the other host used a *completely different*
  implementation (`/api/temporal/as-of`, top-level params). Cherry-picking the
  singulance fix would have been wrong.

**Gate:** state which component owns the truth, and why your change belongs
there and not one layer up or down.

## G1. VERIFY THE CLAIM, NOT THE COMMENT

Comments and docs are hypotheses. The running code is the fact.

- **Incident:** header said *"raw file kept for replay"* while `_process`
  unlinked the file on the final attempt. Replay was impossible. Building the
  retry endpoint on that promise would have shipped a feature that could never work.
- **Incident:** tool docs advertised `limit` (default 20); the schema had no
  `limit` param and returned 3.1MB.

**Gate:** every claim you rely on is confirmed by reading the code path or
measuring the running system. Quote the evidence in the commit.

## G2. MEASURE BEFORE YOU PRIORITISE

Rank by observed impact, never by intuition.

- **Incident:** the per-document fact cap was called "the single biggest issue".
  It was **correct design** — memories are curated, not exhaustive; evidence
  carries the full text. The real defect next to it was that selection was
  first-N instead of most-salient-N.
- **Incident:** disk reported at 92% and flagged as urgent; it was transient
  build pressure and self-resolved to 69%.

**Gate:** a priority claim carries a number from production, or it is a guess and
is labelled one.

## G3. FIND THE INVARIANT YOUR CHANGE TOUCHES

Ask what silently depends on the thing you are changing.

- **Incident:** `rels[].to` is a POSITION in the fact array, resolved
  positionally after filtering. Dropping any fact mid-array shifted later facts
  and wired relationships to the **wrong memories** — a confidently wrong edge,
  not a missing one. It was invisible until per-condition drop counters exposed
  mid-array rejections.

**Gate:** list the invariants (ordering, indices, ids, counts, scopes) the change
can violate, and prove each still holds.

## G4. NO SILENT FALLBACK

A fallback that hides its own activation is a future outage.

- **Incident:** `getMemoryScoped` routed on ambient `currentOrg()`; with no
  context it silently read central Postgres and returned null for BYOD orgs.
  Chat could recall and save but not update.
- **Incident:** Redis unreachable → inline mode with no retry/DLQ/status,
  announced only by two startup WARNs.
- **Incident:** MCP posted nested `time:{}` that the route never read; the filter
  was dropped and `hivemind_at` returned the whole corpus while looking correct.

**Gate:** every fallback logs that it fired and why, and is visible in
status/health. Prefer an explicit argument over ambient state.

## G5. ADVERSARIALLY VERIFY YOUR OWN FIX

Assume your patch introduced the next bug. It usually did.

- **Incident:** drop counters shipped without a `capped` bucket → `dropped=15`
  with every reason at zero: the exact silent-drop class the counters existed to
  kill, reintroduced by the fix for it.
- **Incident:** the `respond_directly` guard listed `change`/`update` as state
  questions — write verbs. It could hijack a memory edit into a read and discard
  the user's change.
- **Incident:** fixing the modal's role derivation changed the admin default from
  personal to organization, which is how a project upload landed at org scope.

**Gate:** write the test that would catch *your* change misbehaving, plus the
no-regression case for what you did not intend to touch. Add a self-check
(e.g. `UNACCOUNTED=`) where counts must reconcile.

## G6. PROVE DESTRUCTIVE AND WRITE PATHS BEFORE SHIPPING

- **Incident:** the raw-file sweeper deletes files. It was proven against a real
  temp tree (aged deleted, recent kept, empty dirs pruned, populated dirs
  untouched) before it ever ran in production.
- **Incident:** delete-cascade was verified by counting seven tables before and
  after a real delete — not by reading the handler.

**Gate:** destructive code ships with a test that proves what it does *not*
delete. Verification is a measurement, never a code read.

## G7. VERIFY ON THE RUNNING SYSTEM, ON THE RIGHT HOST

- **Incident:** `hm-core` was healthy while serving old code, because the deploy
  built a stale SHA from an unfetched remote-tracking ref.
- **Incident:** an MCP fix was verified against the wrong deployment entirely;
  the connector points at a different host than singulance.

**Gate:** confirm the image revision equals the intended commit, confirm the
change is baked into the running container, then exercise the actual behaviour.
Health checks are not proof.

## G8. REPORT WHAT IS TRUE

- Say which part is verified and which is not. "Proven at API level, not
  click-verified" is a complete answer; implying both is not.
- Correct your own earlier claim the moment evidence contradicts it, and say so.
- Record the decision and its rationale so the next session does not re-derive it.

---

## The loop, in order

1. **RECON** — who owns this truth? (G0, G1)
2. **MEASURE** — what does production actually say? (G2)
3. **SCOPE** — which invariants can this break? (G3)
4. **BUILD** — explicit over ambient; no silent fallback. (G4)
5. **SELF-ATTACK** — test your fix's own failure mode + the no-regression case. (G5, G6)
6. **DEPLOY + PROVE** — right host, baked image, real behaviour. (G7)
7. **REPORT + RECORD** — verified vs not; journal + ledger + memory. (G8)
8. **LOOP** — any red goes back to step 3 with the failure as input.

A feature is done when a hostile reader cannot find an unverified claim in it.
