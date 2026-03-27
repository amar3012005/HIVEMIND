# CSI Development Roadmap

## Completed (2026-03-27)

### Phase 1: Trail Executor (Gap A)
- 12 executor components
- Force-routed trail selection (8 dimensions, softmax)
- Real tools: graph_query, write_observation, http_request
- Done detection, reuse penalty, tool chaining
- LeaseManager for concurrency control
- 79 tests

### Phase 2: Blueprint Extraction (Gap A→3)
- ChainMiner mines repeated successful chains
- Blueprint trails (kind: "blueprint") with actionSequence
- Selector boost (blueprintPrior: 0.3)
- Post-execution mining hook (async)
- 94 tests

### Phase 3: Agent Identity (Gap B)
- Hybrid creation (implicit/explicit)
- ReputationEngine (EMA, per-tool, per-blueprint)
- ForceRouter V2 (socialAttraction + momentum)
- Specialization confidence (evidence-gated)
- 116 tests

### Phase 4: Meta-Loop (Gap D)
- Dashboard (4 read-only analytics endpoints)
- MetaEvaluator (8 detection rules)
- ParameterRegistry (20 parameters, atomic apply, rollback)
- 141 tests

### Phase 5: Decision Intelligence Wedge
- 5 decision tools + 6 LLM accuracy points
- Two-tier heuristics (strong + weak signals)
- Real-time ingestion via SyncEngine hook
- Shadow corpus benchmark (5/5 targets met)
- 171 tests

## Next Steps

### Immediate (1-2 weeks)
- Connect real team's Slack + GitHub for richer decision data
- Build 60-second demo video
- Run pilot with first team

### Short-term (1-2 months)
- Da-vinci frontend: CSI dashboard page
- Paper: architecture + experiments + benchmark
- More decision tools: contradiction detection, timeline reconstruction
- Richer ground truth from production connector data

### Medium-term (3-6 months)
- Agent marketplace (specialized agents for different domains)
- Cross-organization intelligence sharing
- Advanced meta-loop: learned force weights, auto-tuned parameters
- More wedges: developer knowledge continuity, compliance tracking

### Long-term Vision
- Fully autonomous cognitive runtime
- Self-spawning specialized agents
- Cross-company intelligence federation
- Environment as persistent organizational brain

## Technical Debt
- Classification precision tested with simulated LLM (need live Groq benchmark)
- InMemoryStore used for testing, PrismaStore for production (need integration tests)
- Trail chaining requires initialContext (needs better working memory seeding)
- Observer platform content triggers false candidates (filtered but not ideal)
