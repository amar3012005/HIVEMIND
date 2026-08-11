# Baseline Establishment

Use this skill when HQ has no current source-backed company baseline, when the
company identity changed, or when an explicit full audit is requested.

## Method

1. Resolve the canonical company identity and website from onboarding memory.
2. Call `growth_baseline_collect` with `full_transfer` for the first run or a
   company change. Use a targeted `refresh` on later checkpoints.
3. Observe connected channels, provider analytics, website evidence, existing
   campaigns, leads, outreach, location, and market signals.
4. Persist the master baseline and per-platform artifacts.
5. Report unavailable evidence as a collection limit. Never infer metrics.

This is a deterministic evidence workflow. It does not require an LLM model.
