# HyperAgents Quality Loop

Standing **enterprise-lens quality regression** for HyperAgents rooms. Runs realistic enterprise
questions through a real room and judges each answer for whether it is **grounded + useful for that
business** vs a **generic LLM response** — the difference between "a digital employee" and "a chatbot."

## Why
Correctness tests (does a turn run, deploy, not crash) ≠ output quality. This loop is the output-quality
gate: it catches when the room drifts into **generic, ungrounded answers** that ignore the company's
real specifics. First run on Solvis found strategy/regulatory/recall well-grounded (0.88–0.92) but
**brand/GTM-strategy drifting generic** (grounded 0.20) → drove the synth anti-generic directive.

## Run
```bash
# on the box, inside the employees container (has the engine + brain + key)
docker exec -i hm-employees python3 < /opt/HIVEMIND/employees-service/scripts/quality/quality_eval.py
# tune: QE_SAMPLES=3 (more samples = less noise), QE_FLOOR=0.7, QE_PROFILE_JSON='{...}' for another room
```
Writes `/tmp/quality_report.json` and prints a per-question + aggregate summary.

## Method (the important part)
- **Average N samples per question.** Single-sample judging is NOISY (±0.22 observed) — averaging is
  what makes the signal trustworthy. Default `QE_SAMPLES=2`; use 3+ for a real gate.
- Judge scores each answer 0–1 on: **grounded** (uses the company's real specifics), specific,
  on-intent, useful-for-exec, + a **generic** flag. Harsh on generic-but-fluent.
- Per-tenant: pass `QE_PROFILE_JSON` (room ids + a short company profile + questions) to point it at
  any customer room.

## Verified findings (2026-06-22, Solvis)
- **Digest cost-opt is quality-SAFE** (n=3/arm: grounded 0.72 ON vs 0.73 OFF, Δ −0.03 = noise).
- Mean quality 0.78–0.82, mean grounded ~0.72. Strong on strategy/regulatory/recall; weak on
  brand/GTM (generic-drift) → ongoing feedback item.

## The loop
test → score (grounded vs generic) → surface weak spots → fix prompts/gather → re-run. Wired as a
recurring cron so quality is tracked and regressions caught **from now on**, not audited once.
