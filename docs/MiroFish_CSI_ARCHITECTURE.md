# MiroFish_CSI Architecture and Design Notes

This document explains how the CSI-oriented Deep Research system works in the current codebase, what is already present, what is missing, and how it differs from MiroFish.

## 1. High-Level Positioning

MiroFish_CSI is the research-focused variant of the broader swarm-intelligence direction.

It is optimized for:
- evidence-backed research,
- knowledge compounding,
- traceability,
- procedure reuse,
- and controlled improvement.

It is **not** primarily a social simulation engine.

## 2. Architecture Summary

The system can be understood in three layers:

### kg/*
Canonical Knowledge

Long-lived, validated, reusable memory:
- entities,
- relations,
- procedures,
- blueprints,
- promoted claims,
- report memories.

### op/*
Operational Cognition

The live execution layer:
- trails,
- agent states,
- source discovery,
- claim extraction,
- verification,
- synthesis,
- SSE event stream.

### meta/*
Control and Learning

The steering and adaptation layer:
- budget control,
- blueprint ranking,
- retained-memory bias,
- diagnostics,
- replay readiness,
- promotion and recall policy.

## 3. Current Execution Flow

The current Deep Research flow is roughly:

1. User submits a research question.
2. The backend creates a research session.
3. Sources are gathered.
4. Claims are extracted.
5. Findings are verified.
6. Trails and provenance are persisted.
7. A synthesis gate pauses before final report generation.
8. Retained memory and blueprints are recalled.
9. The final report is generated.
10. Strong claims are promoted into durable memory.
11. The next run reuses retained memory and blueprints.

## 4. Current CSI Mechanisms

### 4.1 Trails

Trails are the operational record of how research progressed.

They now carry:
- normalized step ids,
- source ids,
- claim ids,
- provenance,
- COT linkage metadata,
- and diagnostics.

### 4.2 Blueprints

Blueprints are reusable procedural patterns discovered from successful trails.

They support:
- rerun reuse,
- pattern ranking,
- replay readiness,
- and blueprint suggestion bias.

### 4.3 Promoted Memory

High-value claims and report artifacts are promoted into durable memory.

That memory is then used for:
- synthesis recall,
- future blueprint ranking,
- and follow-on research runs.

### 4.4 Golden Line

Every report can retain a golden provenance line:

- which nodes were used,
- which claims were used,
- which sources were used,
- which trail steps were used,
- and which recalled memories influenced the result.

This is the retention trace of the report.

## 5. Agent Model

The current canonical research roles are:

- **Faraday**: source discovery and observation capture.
- **Feynmann**: claim extraction and analytical decomposition.
- **Turing**: verification and contradiction handling.

These are not isolated autonomous agents in the fully parallel MiroFish sense.
They are role-based execution modes inside a shared cognitive environment.

## 6. Stigmergic Layer

The system now uses a stigmergic trace model in a limited but meaningful way:

- traces can be followed,
- reasoning can be recorded,
- successful paths can be deposited,
- and later runs can prefer proven paths.

This is the bridge from linear orchestration to environment-driven intelligence.

## 7. Report Synthesis Gate

Before the final report is generated, the backend can:

- recall promoted memory,
- query the trail store,
- read blueprint context,
- and build a structured synthesis prompt.

The synthesis prompt is intentionally:
- sectioned,
- citation-oriented,
- judgment-focused,
- and reusable across runs.

This is where the research loop becomes a controlled synthesis loop.

## 8. Frontend Surface

The frontend currently exposes:

- live research status,
- trail progress,
- provenance summaries,
- promoted memory indicators,
- blueprint replay actions,
- graph layers for trails and memory,
- retained-memory influence badges.

The frontend is intended to look and feel like a research workspace rather than a generic chat page.

## 9. How This Differs From MiroFish

### MiroFish

MiroFish is closer to:
- a simulation engine,
- a parallel digital world,
- agent-to-agent interaction,
- environment injection,
- emergent social behavior,
- and report generation after simulation.

### MiroFish_CSI

MiroFish_CSI is closer to:
- a research memory system,
- a provenance engine,
- a procedural learning substrate,
- and a controlled report synthesis machine.

### Practical Difference

MiroFish emphasizes emergence through simulation.
MiroFish_CSI emphasizes compounding intelligence through persistent knowledge.

## 10. What Is Still Missing

The current system is strong, but not complete.

Still missing or only partially implemented:
- a fully independent multi-worker swarm runtime,
- a complete `Updates / Derives / Extends` semantic ontology across all Deep Research artifacts,
- a richer live browser verification layer for runtime regression checking,
- a more explicit world/simulation layer like MiroFish,
- and deeper graph density for every research artifact type.

## 11. Why CSI Is the Better Research Thesis

CSI is the stronger research thesis because it is:
- more falsifiable,
- more auditable,
- more benchmarkable,
- and easier to prove with real outputs.

MiroFish ideas can strengthen the system, but CSI provides the core research claim:

> intelligence can live in the environment, persist over time, and improve through structured reuse.

## 12. Recommended Implementation Priorities

1. Keep trail provenance exact.
2. Keep blueprint reuse real and visible.
3. Keep promoted memory feeding future recall.
4. Keep the report synthesis gate sectioned and reusable.
5. Expand graph semantics so evidence chains look alive, not sparse.
6. Add more browser-level validation for the live UI.

## 13. File Map

Relevant files in the current codebase:

- `core/src/deep-research/researcher.js`
- `core/src/deep-research/trail-store.js`
- `core/src/deep-research/blueprint-miner.js`
- `core/src/memory/stigmergic-cot.js`
- `core/src/server.js`
- `frontend/Da-vinci/src/components/hivemind/app/pages/DeepResearch.jsx`
- `frontend/Da-vinci/src/components/hivemind/app/pages/DeepResearchGraph2D.jsx`
- `frontend/Da-vinci/src/components/hivemind/app/pages/MemoryGraph.jsx`

