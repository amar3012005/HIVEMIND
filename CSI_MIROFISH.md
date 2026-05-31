# CSI MiroFish — Prompt → Ontology → Agents → Simulation

> How the MiroFish **Cognitive Swarm Intelligence (CSI)** research engine works, end to
> end: from a user's initial prompt + uploaded documents, through LLM-designed ontology,
> graph construction, per-entity agent creation, behavior/role configuration, the
> multi-phase debate simulation, and the citation-linked report.
>
> Code root: `MiroFish/backend/app/` (Flask, 15 services). Companion D3 frontend (Vue 3).
> This is a **separate engine** from `employees-service` — same CSI debate idea, but it
> *constructs a whole synthetic research world from documents + a question and simulates
> agents researching/arguing it.*

---

## 0. Two run modes

`SimulationRunner.start_simulation()` branches on `config_mode`:

- **`social`** → spawns an **OASIS** subprocess (Twitter/Reddit): agents post/like/comment;
  each runtime action is converted into CSI claims/trials via
  `simulation_csi_local.record_runtime_action()`.
- **`deepresearch`** → runs the **`CSIResearchEngine`** directly: LLM-powered research
  rounds. **This document focuses on the CSI / deepresearch path.**

---

## 1. Pipeline overview

```
┌──────────────┐  docs + requirement   ┌────────────────────┐
│ Initial      │ ────────────────────▶ │ 1. OntologyGenerator│  (1 LLM call)
│ prompt + docs│                        └─────────┬──────────┘
└──────────────┘                                  │ 10 entity types + edge types
                                                   ▼
                                        ┌────────────────────┐
                                        │ 2. GraphBuilder     │  Zep / local
                                        │   (typed KG)        │
                                        └─────────┬──────────┘
                                                   │ entities (+ neighbors)
                                                   ▼
                                        ┌────────────────────┐
                                        │ 3. OasisProfileGen  │  1 LLM call / entity
                                        │   (agent creation)  │
                                        └─────────┬──────────┘
                                                   │ OasisAgentProfile[]
                                                   ▼
                                        ┌────────────────────┐
                                        │ 4. SimConfigGen     │  5 LLM calls
                                        │  time/event/agent/  │
                                        │  platform/research  │
                                        └─────────┬──────────┘
                                                   │ activity + CSI roles + policies
                                                   ▼
                                        ┌────────────────────┐
                                        │ 5. CSIResearchEngine│  5 phases × N rounds
                                        │   run_research_rounds
                                        └─────────┬──────────┘
                                                   │ Claim/Trial/Recall/Relation (JSONL)
                                                   ▼
                                        ┌────────────────────┐
                                        │ 6. ReportAgent      │  ReAct + CSI tools
                                        └────────────────────┘
```

UI maps to a 5-step wizard: Graph Build → Env Setup → Simulation → Report → Interaction.

---

## 2. Stage 1 — Initial prompt → Ontology
`services/ontology_generator.py :: generate(document_texts, simulation_requirement)`

One LLM call (`temperature=0.3`, JSON mode, `ONTOLOGY_SYSTEM_PROMPT`) turns the docs +
the user's requirement into a knowledge-graph **ontology**:

```json
{
  "entity_types": [
    {"name": "Professor", "description": "...", "attributes": [...], "examples": [...]}
  ],
  "edge_types": [
    {"name": "WORKS_FOR", "description": "...", "source_targets": [...], "attributes": [...]}
  ],
  "analysis_summary": "..."
}
```

Rules baked into the prompt:
- **Exactly 10 entity types** — 8 specific (Student, Professor, Company, University,
  MediaOutlet, Official, …) + **2 mandatory fallbacks: `Person`, `Organization`**.
- The system is framed as a **social-media opinion simulation** → entities = "anything
  that can speak"; edges = repost / comment / respond / support / oppose.
- Output becomes Zep `EntityModel` / `EdgeModel` (Pydantic).

---

## 3. Stage 2 — Ontology → Knowledge graph
- `text_processor.py` extracts + chunks document text.
- `graph_builder.py`: `create_graph()` → `set_ontology(graph_id, ontology)` →
  `add_text_batches(chunks)` → builds a **typed** graph (Zep cloud, or local JSON).
- `zep_entity_reader.py` reads entities back (`read_entities`,
  `enrich_entity_with_neighbors`) → `EntityNode` objects feed the next stage.

---

## 4. Stage 3 — Agent creation (one agent per graph entity)
`services/oasis_profile_generator.py :: generate_profile_from_entity(entity)`

Agents are **not hand-written** — each graph entity becomes one agent. Per entity:
1. Build context from the entity's attributes + graph neighbors/edges.
2. LLM writes a rich persona.
3. `_ensure_qualified_profile()` sanitizes (rejects generic "any natural person"), applies
   famous-person overrides, fills role/skills, clamps `qualification_score`.

`OasisAgentProfile` fields:
```
user_id, user_name, name, bio (200 chars), persona (400–700 chars),
age, gender, mbti, country, profession, interested_topics[],
karma / follower_count / statuses_count        # social platform stats
role            # CSI role e.g. "Domain Expert", "Investigative Reporter"
skills[3–8], qualification_score [0..1]          # credibility
source_entity_uuid / source_entity_type          # provenance back to the graph
→ to_reddit_format() (JSON) | to_twitter_format() (CSV)
```
`persona` includes background, MBTI, posting style, stance, and a **personal memory** of
the event (the entity's prior actions/reactions). Famous people (e.g. Einstein) get
hardcoded `FAMOUS_PERSONA_OVERRIDES`.

---

## 5. Stage 4 — Simulation config (behavior + research workflow)
`services/simulation_config_generator.py :: generate_config()` — 5 LLM calls:

1. **TimeSimulationConfig** — China-timezone activity curve: `total_simulation_hours=72`,
   `minutes_per_round=60`, peak 19–22h ×1.5, off-peak 0–5h ×0.05, work 9–18h ×0.7.
2. **EventConfig** — topics, seed posts, narrative direction.
3. **AgentActivityConfig** (batched 15/agent) — `activity_level, posts_per_hour,
   comments_per_hour, active_hours, stance, sentiment_bias [-1..1], influence_weight`,
   plus CSI expert fields (`role, skills, qualification_score, domain_tags,
   evidence_preferences, disallowed_claims`).
4. **PlatformConfig** — Twitter vs Reddit recency/engagement weights.
5. **ResearchWorkflowConfig** (deepresearch only) — assigns **8 CSI roles** across agents:
   `explorer, domain_expert, fact_checker, challenger, synthesizer, communicator,
   methodologist, second_domain_expert` → `ResearchAgentAssignment` (responsibility,
   evidence_priority, output_types, challenge_targets). And the **gate-keeper policies**:
   - `claim_policy` — mandatory_citation, verification_requirement = `two_peer_reviews`
   - `debate_policy` — targeted_critique, require_opposing_viewpoint, max_consecutive_challenges
   - `verdict_policy` — consensus_threshold, confidence_scoring_mandatory
   - `provenance_policy` — minimum_sources_per_claim, track_source_graph
   - `gate_policy` — block_final_synthesis_if_low_coverage, minimum_claim_verification_rate

---

## 6. Stage 5 — Simulation = CSI research rounds
`services/csi_research_engine.py :: run_research_rounds(num_rounds, simulation_requirement)`

Each round runs **5 phases** (parallel where safe, `ThreadPoolExecutor max_workers=8`).
Each phase = one LLM call through `AgentHarness`, producing an **append-only artifact**.

| Phase | Method | What the agent does | Artifact produced |
|---|---|---|---|
| **1 Investigation** | `_run_investigation_phase` | Pull top-4 relevant sources by its query terms | **Recall** `{query, source_ids, snippets, score, round_num}` |
| **2 Proposal** | `_run_proposal_phase` | Build an evidence-grounded **claim** from its recall; may emit `search_web` → ingest new sources → retry | **Claim** `{text, source_ids, confidence, status:proposed}` + `derived_from` relations to each source |
| **3 Peer Review** | `_run_peer_review_phase` | 2 diverse reviewers (≠ proposer) adversarially challenge each claim against sources | **Review** + **Trial** `{verdict}` + `supports`/`contradicts`/`needs_revision` relation |
| **4 Revision** | `_run_revision_phase` | If verdict = `needs_revision`, original proposer rewrites with feedback | **Claim** `{status:revised, revision_of}` + `updates` relation |
| **5 Synthesis** | `_run_synthesis_phase` | (last round only) consolidate related claims into one finding | **Claim** `{status:synthesized}` + `derived_from` relations |

Mechanics:
- **Confidence is recomputed, not trusted** — `recompute_claim_quality()` recalibrates from
  actual evidence count + source credibility after proposal and after each review.
- **Verdicts** ∈ `{supports, contradicts, needs_revision}` (`csi_schema.VALID_VERDICTS`);
  `relation_type_for_verdict()` maps verdict → graph edge.
- **Web search loop**: any phase can return `{action:"search_web", query}` →
  `_ingest_web_results()` adds Sources → phase retries with fresh evidence.
- **Gate policy** can stop rounds early (coverage / verification-rate thresholds).
- Run summary: `{rounds_completed, total_claims, total_trials, unique_sources_cited,
  web_sources_discovered, reviewed_ratio}`.

### Single-round sequence diagram

```
User requirement + roster + sources
        │
        ▼
┌────────────────────────────────────────────────────────────────┐
│ ROUND r                                                          │
│                                                                  │
│  P1 INVESTIGATION  (parallel, per agent)                         │
│    agent ──query terms──▶ source pool ──top4──▶ Recall ▣         │
│                                                                  │
│  P2 PROPOSAL  (parallel, per agent)                              │
│    agent + Recall ──LLM──▶ "claim"?  ──▶ Claim ▣ (proposed)      │
│                      └──▶ "search_web"? ──▶ ingest Sources ──▶ retry
│    Claim ──derived_from──▶ Source(s)                             │
│                                                                  │
│  P3 PEER REVIEW  (parallel, per claim × 2 reviewers)             │
│    reviewer ──LLM (adversarial)──▶ verdict                        │
│       verdict ∈ {supports | contradicts | needs_revision}        │
│    ──▶ Review ▣  +  Trial ▣                                       │
│    Trial ──supports/contradicts/needs_revision──▶ Claim          │
│    recompute_claim_quality(Claim)                                │
│                                                                  │
│  P4 REVISION  (only if any verdict == needs_revision)            │
│    proposer ──LLM (incorporate feedback)──▶ Claim ▣ (revised)    │
│    revisedClaim ──updates──▶ originalClaim                        │
│                                                                  │
│  P5 SYNTHESIS  (only on last round, per agent w/ related claims) │
│    agent ──LLM──▶ Claim ▣ (synthesized)                          │
│    synthClaim ──derived_from──▶ each related Claim               │
│                                                                  │
│  gate_policy.check() ── satisfied? ──▶ stop early                │
└────────────────────────────────────────────────────────────────┘
        │ all artifacts appended to csi/*.jsonl
        ▼
   next round, or → ReportAgent
```

---

## 7. CSI artifact schema (`services/csi_schema.py` + engine)

```
Claim    { claim_id, agent_id, agent_name, entity_uuid/name/type, role,
           text, source_ids[], confidence[0..1],
           status ∈ {proposed, under_review, revised, synthesized},
           round_num, revision_of? }
Trial    { trial_id, trial_kind:"peer_review", query_agent(proposer),
           target_agent(reviewer), claim_id, query, response,
           verdict ∈ {supports, contradicts, needs_revision}, source_ids[], round_num }
Review   { review_id, claim_id, agent_id, verdict, text(critique), confidence, round_num }
Recall   { recall_id, agent_id, query, source_ids[], snippets[{source_id,title,snippet}],
           score, round_num }
Relation { relation_type ∈ {supports, contradicts, needs_revision, derived_from,
           updates}, from_id, to_id, metadata }
Source   { source_id, title, url, content, summary, source_type ∈ {web,document,local},
           metadata{discovery{kind,agent,role,round,query}, origin} }
```

Everything is **provenance-linked**: claim→source (`derived_from`), trial→claim
(`supports`/`contradicts`), revised→original (`updates`), synthesis→constituents
(`derived_from`). The D3 graph renders these (Claim = purple `#7B2D8E`, Trial = orange
`#FF8A34`, Recall = blue `#2196F3`).

---

## 8. Storage, report, HIVEMIND integration

- **Local store** (`simulation_csi_local.py`): append-only JSONL under
  `simulations/<id>/csi/` — `claims.jsonl, trials.jsonl, recalls.jsonl, relations.jsonl,
  agent_actions.jsonl, sources_index.json, state.json, profiles_snapshot.json`.
- **Report** (`report_agent.py`): a **ReAct agent** plans an outline from the CSI summary,
  then writes each section via a tool-calling loop (≤5 calls/section) using CSI tools —
  `query_claims, query_trials, query_consensus, query_contradictions, trace_provenance` —
  plus optional graph tools (`insight_forge, panorama_search`). The report is built *from*
  the debate artifacts, with citations. `chat()` enables follow-up Q&A.
- **HIVEMIND tie-in** (`csi_adapter.py`, `hivemind_client.py`): the adapter can route CSI
  persistence to HIVEMIND instead of local; `persist_research_bundle({claims, trials,
  sources})` POSTs the compressed bundle to HIVEMIND core (`/research/bundle/save`) for
  cross-session recall. This is the **same CSI vocabulary** (claims/trials/verdicts/
  consensus) that HIVEMIND's in-app DeepResearch and Agent Swarm reuse.

---

## 9. Mental model (one line)

> **Docs + a question → LLM-designed ontology → typed knowledge graph → one persona-rich
> agent per entity → LLM-tuned behavior + CSI roles + gate policies → multi-round debate
> (recall → propose → peer-review → revise → synthesize) yielding citation-linked
> claim/trial artifacts → a ReAct-written, fully-provenanced report.**

---

## 10. Key files

| Concern | File |
|---|---|
| Ontology design | `services/ontology_generator.py` |
| Graph build / read | `services/graph_builder.py`, `services/zep_entity_reader.py` |
| Agent creation | `services/oasis_profile_generator.py` |
| Sim config + CSI roles/policies | `services/simulation_config_generator.py` |
| **CSI research engine (5 phases)** | `services/csi_research_engine.py` |
| Artifact schema | `services/csi_schema.py` |
| Local artifact store | `services/simulation_csi_local.py` |
| Run orchestration / OASIS branch | `services/simulation_runner.py` |
| Report (ReAct + CSI tools) | `services/report_agent.py`, `services/zep_tools.py` |
| HIVEMIND persistence | `services/csi_adapter.py`, `services/hivemind_client.py` |
| API blueprints | `api/graph.py`, `api/simulation.py`, `api/report.py`, `api/csi.py` |
| Architecture reference | `MiroFish/ARCHITECTURE.md` |

*Generated from a full read of the MiroFish backend services + ARCHITECTURE.md. Treat the
source files as the authority; line-level details drift as code evolves.*
