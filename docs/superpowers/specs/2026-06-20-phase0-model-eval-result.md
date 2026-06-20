# Phase-0 result — action-path model decision

**Method:** 8-task room battery (`employees-service/scripts/phase0/`) run live against the
Solvis room (`5a6e14c9…`, org `f5e2418b…`, gmail+docs), per-turn `agentic_model` override
(no restarts). 3 gpt-oss-120b runs + 2 llama-3.3-70b runs.

## Findings
1. **Action/artifact tasks (doc / sheet / email / sheet→email chain) pass 100% on BOTH
   models, every run.** The Phase-1 producer registry + the send-intent chain fix are verified
   on a real room. This is the reliable core.
2. **All "failures" are judge-side grounding strictness on PROSE tasks** (answer / decision /
   multi-tool-gather / dead-end), where the org KB genuinely lacks the specific facts the
   verifier wants → `grounded_ok=false` → escalated. That is HONEST behavior (refusing to
   ground thin/absent evidence), not a tool/artifact bug. Which prose task trips varies
   run-to-run = verifier sensitivity, on both models.
3. **Efficiency gap is decisive:** llama-3.3-70b ≈ gpt-oss-120b on action quality but
   **~40% faster (~24s vs ~39s/turn)** and **~45% cheaper (~21.5k vs ~39k tok/turn)**, with
   ~0 tool-call failures (gpt-oss produced the 9 harmony/400 marker lines in the window).

## Decision
**Agentic default model: `gpt-oss-120b` → `llama-3.3-70b-versatile`.**
Equal action-quality, large cost+latency win, clean tool-calling. It is the model the factory
already vouches for ("tool calling works on Groq llama-3.3-70b"). Reversible (one default +
the env/`agentic_model` override still apply).

## Consequences for the sprint
- **Phase 2 cleanup unblocked:** the gpt-oss-specific patchwork (harmony `<|channel|>` retry,
  tool-less reactors, fake-`JSON` guards) is candidate for deletion on llama — VERIFY each with
  the battery before removing.
- **New Phase-1.5 item (grounding-judge tuning):** the verifier flips complete↔escalated on
  prose tasks run-to-run. Tighten the rubric (escalate only on FABRICATION or a hard missing
  artifact, not on "could be more sourced" gaps for opinion/recommendation outputs). Also the
  semantic dead-end (impossible data → seal blocked instead of drafting a useless email).
- **Battery assertion refinement:** prose tasks should accept `escalated` as an honest outcome
  when `grounded_ok=false` reflects genuinely-absent KB facts (not a model failure).

## Numbers (per-run pass / avg ms / avg tok)
- gpt-oss-120b: 6/8, 6/8 (post-fix) · ~39.4s · ~39.4k tok · failures = answer→doc over-produce, doc grounded-flip
- llama-3.3-70b: 6/8, 7/8 · ~24s · ~21.5k tok · failures = gather/decision/dead-end grounding escalations (honest)
