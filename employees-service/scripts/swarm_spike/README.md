# swarm_spike — Groq llama-8b personified social simulation (CSI spike)

A standalone Groq **tool-calling** script that reproduces the MiroFish **CSI** behavior
(`CSI_MIROFISH.md`) on the **cheapest** model (`llama-3.1-8b-instant`), and an A/B harness
that **measures what makes an 8b persona accurate** — so we know how to power the swarm.

```
context pool ─▶ personas (multi-perspective) ─▶ N rounds × 5 phases
   recall(internal, over the pool) → propose (native tool-calling, in-character)
   → peer-review (2 adversarial reviewers) → revise → synthesize
        ▼ grounded, provenance-linked claim / trial / recall artifacts (JSONL)
```

- **Agent model:** `llama-3.1-8b-instant` (the cheap model under test) — every persona turn.
- **Internal recall:** lexical retrieval over the chunked context pool, called by the agent
  as a native tool (`recall(query)` → top snippets + `[S#]` source ids it must cite).
- **Internal web search:** `web_search(query)` → `groq/compound-mini` (live web), opt-in `--web`.
- **Judge:** `openai/gpt-oss-120b` (NOT under test) scores each post on in-character /
  stance-consistency / grounding / specificity (0..1).
- **Cost:** every model is metered separately (agent 8b vs judge 120b vs web).

## Usage

```bash
# env: LLM_API_KEY (Groq gsk_...) — auto-read from MiroFish/.env if unset
python3 social_sim.py --topic "Should SINGULANCE raise a seed round now?"
python3 social_sim.py --topic "..." --context notes.txt --agents 6 --rounds 2 --web
python3 social_sim.py --topic "..." --ab --trials 3 --no-sim   # personification study only
```

Outputs `runs/<ts>/`: `claims.jsonl trials.jsonl recalls.jsonl relations.jsonl report.md`.

## What we learned (grounded — 4 runs, judge = gpt-oss-120b)

Mean `overall` per prompt strategy (rich = background+stance+MBTI+voice):

| strategy | what it adds on top of the persona | verdict |
|---|---|---|
| **S2 rich + personal-memory** | a 1-2 line "prior take / memory of this event" | **best / top-tier** |
| **S3 rich + few-shot voice** | one in-character example line | top-tier |
| **S4 rich + grounding-discipline** | "cite [S#], mark UNVERIFIED, never invent" | top-tier (best grounding dim) |
| S1 rich persona only | — | mid |
| **S5 everything stacked** | memory + few-shot + grounding all at once | **near-worst (overloads 8b)** |
| **S0 bare persona** | "you are X, a Y" | **worst (generic)** |

**Robust findings (reproduced every run):**
1. **Bare persona (S0) is worst** — 8b goes generic. Rich detail is mandatory.
2. **The kitchen sink (S5) consistently regresses** — stacking memory + few-shot + grounding
   prose overloads 8b and *drops* in-character voice and stance-consistency. More prompt ≠ better.
3. **Sweet spot = rich persona + exactly ONE focused anchor** (a *personal memory* of the event
   is the cheapest, most reliable; a few-shot voice line is close).
4. **Grounding is 8b's weakest axis** (~0.5–0.7). It under-cites even when told. A *bigger context
   pool* + the explicit grounding instruction (S4) raise the grounding dimension specifically.

**For the swarm:** frame each agent as **rich-persona + a personal memory of the event**; give it
the **recall tool + a short "cite [S#]" line** (not a wall of grounding prose); feed a **large
context pool**; keep **synthesis + scoring on a stronger model** (8b is fine for the bulk
persona turns, weak at final rigor + citation). This mirrors HIVEMIND's multi-model split
(cheap gather/debate, strong synth/judge).

## Scale (realtime, measured)

`python3 social_sim.py --scale 150 --concurrency 24` — ontology → population → parallel burst:

| | |
|---|---|
| personas (ontology→cast, batched-parallel) | **151 in 3.7s** |
| posts (grounded in-character, recall tool) | **146/151 (97%)**, 133 cite [S#] |
| burst | **11.7s · 12.5 posts/sec** |
| end-to-end | **16.8s** |
| cost (8b) | 252k in / 61k out (~pennies) |
| limiter | **Groq 429s** — 39 hits @ concurrency 24; backoff recovered 97%. Lower `--concurrency` (~16) or a paid tier to smooth. |

Verdict: a 150-voice realtime social burst is feasible on `llama-3.1-8b-instant` for cents in
~17s. Rate limit (not the model) is the ceiling. Full CSI peer-review at 150 is the heavier
deepresearch path, not this realtime burst.

## Rate-limit fallback + 120B report (measured)

`python3 social_sim.py --scale 150 --concurrency 30` (now with model fallback + report):

- **Fallback chain** (`SWARM_FALLBACKS`, default `gpt-oss-20b,llama-3.3-70b-versatile`): on a 429
  the call escalates to a different-family model (separate rate-limit bucket) instead of dropping.
  Measured: **18× 429 → 20 calls saved on gpt-oss-20b → 151/151 posts (zero drops)**, 9.5s burst
  (15.9 posts/sec), 13.9s end-to-end. Served: `llama-8b×287, gpt-oss-20b×20`.
- **High-level report** (`SWARM_REPORT_MODEL`, default `gpt-oss-120b`, MiroFish ReportAgent analog):
  a decision-grade report over the whole population — executive read, **consensus table (who backs
  what)**, **fault-lines table (which factions split)**, strongest arg per faction, most-cited
  evidence [S#], net recommendation + gaps. `--no-report` to skip.

Architecture that emerges: **8b for the realtime persona burst (cheap, parallel), fallback model
for rate-limit overflow, 120B once for the report** — the multi-model split, applied to a 150-voice
social sim that runs in ~14s for cents.
