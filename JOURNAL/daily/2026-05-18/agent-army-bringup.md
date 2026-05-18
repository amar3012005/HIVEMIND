# Agent Army + Journal Scaffold

**Date:** 2026-05-18 20:30
**Trigger:** User: "build me army as best developers in world ... keep track in physical journal folder so even after compact nothing happens"
**Risk:** low (additive scaffolding, no prod code)

## What was built

### .claude/agents/ (project-scoped)
21 specialist agents written:

**Tier 0:** orchestrator
**Tier 1 (recon):** cartographer, historian
**Tier 1 (design):** architect, planner
**Tier 1 (impl):** tdd-writer, implementer-backend, implementer-frontend, implementer-infra
**Tier 1 (domain):** nango-specialist, mcp-specialist
**Tier 1 (review):** code-reviewer, db-reviewer, security-reviewer
**Tier 2 (red team):** bug-hunter, threat-modeler, performance-critic
**Tier 1 (ship):** e2e-runner, deploy-operator
**Tier 3 (knowledge):** memory-curator, contract-keeper, doc-updater, journal-keeper

### JOURNAL/ structure
- INDEX.md (master TOC)
- daily/YYYY-MM-DD/ (per-task entries)
- decisions/, incidents/ (incl. backlog.md), playbooks/, handoffs/
- Templates documented in journal-keeper.md
- Initial playbooks: env-matrix, nango-providers, deploy

### COMPANY_BRAIN.md
Appended "Agent Army Protocol" section linking everything.

## Why

Past sessions repeatedly lost context after compaction. Same bugs re-investigated. Three-catalog drift caused real outages. Self-hosted SDK defaults silently leaked cloud URLs. Solution: physical journal + structured agent dispatch protocol.

## Outcome
- Done? Yes for scaffold. Adoption is operational discipline going forward.
- Memory IDs: _(memory-curator to log)_
- Follow-ups: Use this pipeline on next user command. Validate it shortens cycle time and prevents drift bugs.
