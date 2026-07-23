# HyperAgents / Singulance-OS — Active TODO

The `hyperagents-builder` skill writes recon+plan phases here BEFORE coding, then
executes one-by-one, checking each off. `[ ]` pending · `[~]` in progress · `[x]`
done · `[!]` blocked. When a phase ships → JOURNAL entry + check it here.

---

## PROGRAM: Singulance-OS "AI Company" closed loop
Full design in the owner's plan (onboard → verified presence → round-table →
frontier report → outreach contract → TARA acts → learnings ingested; gated by
provenance+actionable-gate and a Governor). Owner-chosen order below.

### In-flight (owner priority 2026-07-23)
- [~] **F0 — employees-service LLM canonicalization** (close the Brain/OS gap FIRST).
  Cerebras→OpenRouter / gpt-oss-120b, NO groq/llama, in the Python sidecar.
  Files: `hyper/engine.py` (model defaults + `_route_direct_openrouter`/`GROQ_URL`
  path + `_GROQ_DEAD`), env (`HYPER_WEB_MODEL`, `MIND_READER_MODEL`,
  `COGNITION_WRITER_MODEL`, `GROQ_INFERENCE_MODEL`, `HIVEMIND_LLM_MODEL`).
  done-when: no text call routes to api.groq.com / a llama model; a room turn +
  round-table run green on gpt-oss via Cerebras→OpenRouter; deployed hm-employees.
  NOTE: `groq/compound*` web-search has no gpt-oss twin — decide (keep isolated as
  a non-text tool, or replace the web lane) rather than blanket-swap.
- [ ] **P3 — eval baseline (moved UP, before P4/P7)** — can't prove a quality win
  without a baseline. `employees-service/evals/hyper_report_eval.py`: N frozen
  `(company_url, task)` → run pipeline → rubric score (grounded? specific?
  actionable? zero hallucinated facts). Baseline now; regression-gate later phases.

### Then the plan (owner's visual-first order, with the two guards above landed first)
- [ ] **P7 — MsgHub round-table debate** — round-2 argues verbatim round-1 peer msgs (`_debate`, engine.py).
- [ ] **P5 — parallel verified presence scan at genesis** — address+socials, ≥2-source `verified` (control-plane onboarding). WRITE to the P0 schema (define P0 fields first).
- [ ] **P4 — `HYPER_SYNTH_MODEL` frontier final report** — one frontier call for the sealed report (engine.py synth seam). Gate cost via Governor. Re-run P3.
- [ ] **P1 — typed contracts at the 4 seams** — CompanyProfile/RoundtableReport/OutreachContract/OutcomeReport v1 (JS + pydantic), version-tolerant (accept vN & vN-1).
- [ ] **P0 — provenance + actionable-gate** — `{verification,confidence,actionable}`; `actionable && !verified` → ingest reject. **Define the fields+rule BEFORE P5; enforce hard gate BEFORE P6.**
- [ ] **P2 — Governor primitive** — per-org token + outbound caps + kill switch; checked by every autonomous action. Pull the kill switch EARLY.
- [ ] **P6 — Outreach Contract v1 (TARA autonomy)** — LAST, GATED on P0. Report emits contract; TARA picks skill + sets goal; outcome writes back verified learning.

### Adjustments I recommend (from the high-level review — owner to confirm)
- Verification = ≥2 *independent* sources needs real design (source-class independence,
  normalization, human-approval rung on first autonomous dials) — it's the moat AND the liability.
- P3 baseline before P4/P7 (done above). Contracts version-tolerant so JS/Python deploy independently.

## Superseded / historical
- **Agentic orchestrator (AgentScope PlanNotebook + MsgHub), started 2026-06-19,
  parked at P2, flag OFF (`HYPER_AGENTIC_ORCHESTRATOR`).** Not part of this program;
  left as-is (flag off). Revisit only if the round-table path needs its subtask model.

## Backlog
- [ ] MCP-connector search in GATHER (Notion/Slack/GitHub) when a room enables an MCP connector.
- [ ] Verifier strictness on LLM-authored `done_criterion` (sometimes demands unrequested sections).
- [ ] Extend GROUNDING GATE to swarm + deep_sim save paths.
