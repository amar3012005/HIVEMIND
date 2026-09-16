---
name: platform-evals
description: Create or run fixture-driven platform evaluations, browser canaries, authorization checks, replay/resume tests, and release evidence.
---

# Platform evals

Use for proof rather than implementation. Build focused fixtures around the contract being changed,
including denial and recovery behavior where relevant. Browser canaries must exercise the
authenticated route and persisted state, not only a static shell. Keep evidence compact and tied to
the artifact/source SHA under evaluation.
