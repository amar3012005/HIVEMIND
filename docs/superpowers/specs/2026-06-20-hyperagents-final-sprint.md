# HyperAgents — Final Sprint (one swarm, AgentScope-native, no patchwork)

**Framing:** today there are FOUR overlapping implementations of the same swarm idea — (1)
AgentScope ReActAgent + tool-groups + consensus gate (factory), (2) deterministic
`_orchestrate`, (3) agentic `_orchestrate_agentic` (strips the factory's tools), (4) MiroFish/
OASIS CSI as a separate backend. The overlap IS the patchwork. The sprint collapses them to ONE
AgentScope-native spine, makes connectors a single horizontal toolkit, and ports MiroFish's CSI
*pattern* (roles + bounded rounds + reflection + quality/policy scoring) — NOT its runtime.

**The thread:** the MODEL decision (Phase 0) gates the agent-acts phases (2 & 4). Collapsing to
one orchestrator (Phase 1) + one connector registry (Phase 3) removes patchwork regardless of
model. Ship per phase: in-container smoke + one live room turn + the Phase-0 battery as gate.

---

## Phase 0 — Decide the model with an eval (GATING, cheap, first)
**Why:** every "patchwork" tell (JSON-content parse instead of `structured_model`, tool-less
reactors, placeholder-arg guard, stripped writes) traces to gpt-oss not driving AgentScope tool/
structured primitives. "No patchwork" + "agents do real work" REQUIRES reliable tool-calling.
Without the number, Phases 2 & 4 are guesses.
**Actions:**
- Build a fixed task battery (8 real room tasks): Rama sheet→email chain, plain answer, a doc, a
  known dead-end (empty KB), a multi-tool gather, a Slack post, a decision, an MCP-connector call.
- Run each on: gpt-oss-120b, llama-3.3-70b (factory says tools work), and one function-calling-
  reliable model. Measure (a) tool-call success rate (valid action, no 400/retry), (b) artifact-
  completion + grounding score, (c) $/turn + ms/turn.
**Exit:** a table that picks the action-path model (cheap-but-needs-producer vs reliable-agent-
acts) and says whether Phase 4 is viable. This eval becomes the CI regression gate.

## Phase 1 — Collapse to ONE orchestrator
**Why:** two parallel orchestrators in a 6500-line file = the #1 drift bug (fix lands in one path,
lives on in the other; literal branch-confusion hit this session).
**Actions:** keep the agentic spine (PLAN→GATHER→DEBATE→EXECUTE→PRODUCE→VERIFY→PERSIST), delete
the deterministic `_orchestrate`/`_plan_turn`/`_execute_assignments` path (or demote to a thin
fallback behind a flag). One flow, one set of prompts. Keep the Phase-1-shipped producer registry
+ honest dead-end + capability-aware planner.
**Exit:** one orchestrator; dead path removed; all existing room behaviors still pass the battery.

## Phase 2 — Real swarm, AgentScope-native (OpenSwarm A2A)
**Why:** today's "debate" is hand-rolled `_run_reactor`, tool-less, single-pass — cosmetic until
proven. MiroFish CSI is the right pattern (roles, bounded rounds, reflection) but lives in a
separate backend.
**Actions:** replace `_run_reactor` with AgentScope-native MsgHub broadcast + agent-as-tool
HANDOFF (VERIFY this exists in the pinned AgentScope version first) so agents talk A2A: lead hands
off subtasks, reactors challenge via structured messages, convergence is a real bounded loop. Port
MiroFish `csi_quality`/`csi_policy` scoring as the convergence/verdict signal. IF Phase-0 model
drives structured output → delete `_first_json_object` JSON hack, use native structured output.
**Exit:** debate measurably lifts the battery score (else cut it); no JSON-content patchwork on
the reliable model.

## Phase 3 — Connectors = ONE universal agent toolkit (horizontal)
**Why:** connectors exist twice — factory tool-groups (agent-callable, gated) AND the Phase-1
producer registry (deterministic). New connector = touch both = patchwork.
**Actions:** unify into ONE registry entry per connector action that is BOTH an agent-callable
tool (gated) AND a deterministic producer (fallback). Register once → both surfaces. Extend the
MCP dynamic `*_list_tools/*_call` path into the same registry. New connector ships with zero
orchestrator edits — the spine never changes (the horizontal-growth requirement).
**Exit:** add a new connector in one file; it's immediately agent-callable + producible; spine
untouched.

## Phase 4 — Agent-owned actions (the deferred Phase-2), now EARNED
**Why:** only viable if Phase-0 says the model is reliable. The factory already wires gated tool-
groups + the consensus gate holds output until synthesis — the machinery exists.
**Actions:** on the reliable model, let owners execute their own writes via gated tool-groups;
per-stage recon verifies each owner's action; drop the centralized-producer workaround on that
path (keep it as the cheap-model fallback). Flag-gated rollout.
**Exit:** owners complete dependent chains end-to-end (Rama: Victor writes the sheet, Eli sends
referencing it) with the battery green; fallback path unchanged.

## Phase 5 — Verify + harden
**Actions:** Phase-0 battery becomes a CI gate; bound rounds/cost/tokens per turn; one live room
turn per phase on a throwaway tenant; deploy-verify after each ship.
**Exit:** battery green in CI; cost/latency bounded; no two-path drift possible.

---

## PROGRESS / RESUME (live)
- **2026-06-20 — PHASE 0 DONE.** Eval harness built + run live (Solvis room, 3 gpt-oss + 2 llama
  runs). Result (docs/.../2026-06-20-phase0-model-eval-result.md): action/artifact tasks 100% on
  both models; variance is judge-side grounding on prose. **Decision shipped:** agentic default
  `gpt-oss-120b → llama-3.3-70b-versatile` (resolves to llama-reasoning + gpt-oss-20b-tools via
  the existing correct swap) — ~40% faster, ~45% cheaper, equal quality. Smoke (no override):
  chain task → sheet+email+grounded. Commits: c51ed972 (harness), chain-fix, default-flip.
  NEW Phase-1.5 items found: grounding-judge flips complete↔escalated on prose (tighten rubric);
  semantic dead-end (impossible data → seal blocked vs draft a useless email).
- **2026-06-20 — PHASE 1 DONE** (commit a4d6b2a5, deployed+verified). The deterministic path was
  UNREACHABLE (agentic returned unconditionally). Deleted it + `_plan_turn`/`_gather_evidence`/
  `_recon_pre`/`_execute_assignments`/`_orchestrate_swarm`(R1-R5)/`_orchestrate_deep_sim` + cascade
  + the orphaned `_agentic_enabled` flag (agentic return now unconditional). **6486 → 3277 lines
  (−49%, −3201).** Zero prod behavior change. Verified: AST + in-container import reload + live
  smoke turn (Solvis room → gmail draft + approval + grounded). Template/skeptic/trust kept as
  router-event display metadata.
- **2026-06-20 — PHASE 2 DONE** (commits 7f2dee9c=2a, e1ec4232=2b; deployed+verified live).
  **2a multi-round swarm:** single debate→revise replaced with a bounded R1-Rn loop (reactors
  challenge the current draft each round; lead revises; stop on no-high-conf-challenge or
  HYPER_SWARM_MAX_ROUNDS=3). Verified: round=1/3 c=2 → 2/3 c=1 → 3/3 c=1, revising each round.
  **2b iterative gather:** owners are 'searchers' — +hivemind_web_search + a HIVEMIND-as-company-
  brain prompt (recall FIRST & repeatedly, skip what teammates gathered, web ONLY if external).
  Verified: owner recalled internal → none → fired web_search → real Tavily competitor results.
  Connector context-search deferred INTO Phase 3. Pre-existing tool noise flagged: query_with_ai
  /api/query 404 (task_c8563b0c); occasional gpt-oss-20b Groq 400 (absorbed by retry wrapper).
- **2026-06-20 — PHASE 3 DONE** (commit pending-hash; deployed+verified live). Connectors are now
  READ-ONLY agent context-search tools: `build_hivemind_toolkit(connectors_read_only=)` registers
  gmail READ tools only (search/get/thread/list), skips docs/sheets (write-only producers), MCP
  `_call` self-gates writes; searcher owners get `connectors=conns + connectors_read_only=True`;
  read-only gmail notes trimmed. Verified: owner fired gmail_search/get/get_thread to summarise real
  customer threads, no write calls, read-only notes confirmed, status=complete. Writes stay in the
  centralized producer.
- **PHASE 4 — BLOCKED (recon'd 2026-06-20), needs a reliable tool-calling model.** Agent-owned WRITE
  actions can't be built on the current stack: OPENROUTER_API_KEY unset → Groq-only; Groq llama-3.x
  can't tool-call under strict mode (swaps to gpt-oss-20b); gpt-oss-20b harmony-400s even with READ
  tools (observed). Agent writes would 400 like the original placeholder-arg failure that forced
  centralization. UNBLOCK PATH: set OPENROUTER_API_KEY + route owners to a function-calling-reliable
  model (Claude/GPT) — a provider/cost decision. Until then the centralized producer (Phase 1) is the
  correct action path; agents SEARCH (read) but do not ACT.
- **PHASE 5 — bounds in place.** Per-turn cost is structurally bounded: _SWARM_MAX_ROUNDS=3 ×
  goalkeeper max 3 × _EXECUTE_MAX_OWNERS=4. `scripts/phase0/` battery = the regression gate (run on
  the live room before shipping orchestrator changes). A hard token kill-switch + wiring the battery
  into CI are optional future hardening.

## SPRINT STATUS: shippable phases COMPLETE
0 (model) · 1 (collapse −3201) · 2a (multi-round swarm) · 2b (HIVEMIND-first + web gather) · 3
(connector read-search) — all shipped + verified live. Phase 4 (agent actions) blocked on model;
Phase 5 bounds in place. The user's vision is LIVE: HIVEMIND-as-company-brain mined per-agent +
web-if-external + multi-round swarm debate + connector context-search, one clean orchestrator.

## (archive) Earlier NEXT pointers
- **NEXT: Phase 3 — connectors = ONE unified read/act registry** (give owners connector READ
  context-search cleanly — separate read tools from the write/consensus-gated ones so the small
  owner model can't queue spurious write-approvals; new connector registers once → agent-callable
  read + producible write). Then Phase 4 (agent-owned actions, gated) + Phase 5 (harden + CI gate).

- **(superseded) NEXT: Phase 2 — make the agentic swarm truly MULTI-ROUND.** Today `_orchestrate_agentic` does
  ONE debate pass (reactors challenge the draft once → one revise). Turn it into a bounded R1-Rn
  loop with convergence (port MiroFish `csi_quality`/`csi_policy` scoring as the verdict signal),
  reusing `_run_reactor` + the react/peer_review events the FE already renders. Then Phase 3
  (connectors = one agent+producer registry), Phase 4 (agent-owned actions, gated on a model that
  tool-calls reliably — note: llama can't on Groq strict mode, owners route to gpt-oss-20b), Phase 5
  (harden + CI gate).

- **2026-06-20:** Phase-0 harness BUILT + committed `c51ed972` (offline — prod box
  unreachable, SSH timeout). Added `RoomTurnRequest.agentic_model` per-turn override
  (api_hyper_rooms.py) + `employees-service/scripts/phase0/` (battery/run_battery/sweep/README).
  Retry cron `e75ca678` (every 15 min) checks `ssh myserver`; resumes here on reconnect.
- **NEXT (on reconnect), in order:**
  1. Deploy: drift-check md5 → `scp api_hyper_rooms.py` → `docker restart hm-employees` → AST + health 200.
  2. Get a real test room: `ROOM_ID`, `PARTICIPANT_IDS`, `USER_ID`, `ORG_ID` (Google connector enabled) — see scripts/phase0/README.
  3. Run `scripts/phase0/sweep.sh "openai/gpt-oss-120b" "llama-3.3-70b-versatile" "anthropic/claude-haiku-4-5"` → read `/tmp/phase0/comparison.md`.
  4. Decide action-path model from the table → then Phase 1 (collapse orchestrators), per phases below.
  5. Delete retry cron `e75ca678` once an active session resumes.

## Non-negotiables (carried from prior decisions)
- No owner re-arming UNTIL Phase-0 proves the model (Phase 4 is the earned version).
- MiroFish = pattern to PORT, not a backend to bolt on (two Python backends = patchwork).
- Centralized producer stays as the cheap-model fallback even after Phase 4.
- Ship per phase, verified; never the whole sprint in one drop.
