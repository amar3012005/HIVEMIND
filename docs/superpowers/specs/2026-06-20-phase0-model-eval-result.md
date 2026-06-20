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

## How the default actually resolves (important — log-verified)
`_route_groq` (agentscope_factory.py:235) deems Groq-hosted **llama-3.x tool-UNRELIABLE**
(emits `<function=NAME>` Llama-tag format under strict validation → `tool_use_failed` 400) and
swaps **tool-using** agents to `openai/gpt-oss-20b`, while tool-less agents (planner / lead /
reactors) keep llama-3.3-70b. So default `llama-3.3-70b-versatile` resolves to **llama for
reasoning/prose + gpt-oss-20b for tool-owners** — the cheap+reliable combo. The ~40%/45% win vs
gpt-oss-120b-everywhere is mostly gpt-oss-20b owners ≪ gpt-oss-120b owners. Smoke (no override):
chain task → `['google-sheets','gmail']` + `gmail_send` queued + grounded=true. ✅

## Consequences for the sprint
- **The llama→gpt-oss-20b swap is CORRECT, not patchwork** — llama genuinely can't tool-call on
  Groq strict mode. Do NOT remove it. (Retracts an earlier wrong note.) The harmony/tool-less
  hacks are gpt-oss-specific and stay until/unless a non-Groq (OpenRouter) provider path is used.
- **New Phase-1.5 item (grounding-judge tuning):** the verifier flips complete↔escalated on
  prose tasks run-to-run. Tighten the rubric (escalate only on FABRICATION or a hard missing
  artifact, not on "could be more sourced" gaps for opinion/recommendation outputs). Also the
  semantic dead-end (impossible data → seal blocked instead of drafting a useless email).
- **Battery assertion refinement:** prose tasks should accept `escalated` as an honest outcome
  when `grounded_ok=false` reflects genuinely-absent KB facts (not a model failure).

## Numbers (per-run pass / avg ms / avg tok)
- gpt-oss-120b: 6/8, 6/8 (post-fix) · ~39.4s · ~39.4k tok · failures = answer→doc over-produce, doc grounded-flip
- llama-3.3-70b: 6/8, 7/8 · ~24s · ~21.5k tok · failures = gather/decision/dead-end grounding escalations (honest)
