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

## Non-negotiables (carried from prior decisions)
- No owner re-arming UNTIL Phase-0 proves the model (Phase 4 is the earned version).
- MiroFish = pattern to PORT, not a backend to bolt on (two Python backends = patchwork).
- Centralized producer stays as the cheap-model fallback even after Phase 4.
- Ship per phase, verified; never the whole sprint in one drop.
