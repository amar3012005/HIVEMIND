# HyperAgents — deep reference (hm-employees)

The reasoning runtime for HIVEMIND **Digital Employees / HyperAgents rooms**.
A room is a persistent multi-agent workspace: a lead (CSI) + reactor personas
that live inside the company brain, run a task end-to-end, and produce a sealed
report. This service is the Python sidecar (`hm-employees`); HIVEMIND **Core**
(Node) owns auth/billing/routing and proxies each turn here.

Written 2026-07-19. Cite pushed SHAs; verify against running code before trusting.

---

## 1. Where things live

```
employees-service/src/hivemind_employees/
  main.py                  FastAPI app; mounts the routers below
  api_hyper_rooms.py       /room-turn, /prewarm, /approve — turn intake, blackboard,
                           company brief, SSE/callback bridge to Core
  api_outreach.py          /outreach/generate — per-prospect email/call, on-demand
                           EMAIL SKILL (cold-email-sequence + polished-email), run-grounded
  api_team_tasks.py        team task endpoints
  api_employee_chat.py     single-employee ReAct chat (/v1/employees/<slug>/chat)
  hivemind_client.py       Core client (recall_emulated, list_canon_emulated,
                           web_search_emulated, connector_exec_emulated, report_llm_usage)
  hyper/
    engine.py              THE ENGINE — one Director class, the whole turn (~2.6k lines)
    rooms/__init__.py      lead_shape_for(kind, io) + shape_debate_members(members, shape)
    skills/                method playbooks per room kind (see §5)
      __init__.py          resolve_room_kind / skill_catalog / load_method_skill / default_skill_for
      outreach|market|strategy|business|content|general/  *.md skill files
```

## 2. The turn pipeline — `Director.run()` (engine.py)

One turn, in order:

1. **PLAN** — `_plan_gather()`: a single structured-JSON call on a FAST model.
   Emits `{turn_mode, recall_queries[], connector_calls[], web_query, places_query,
   needs_debate, method_skills[]}`. This is the router — no regex.
2. **ROUTER** — if `turn_mode == "chat"` → `_chat_turn()`: the lead replies as a
   person (greeting / meta-question / smalltalk), one small LLM call, NO gather /
   web / Maps / debate / report. (Fixes "hallo" burning a 27k-token pipeline.)
3. **GATHER** — `_run_gather()`: recall + connector reads + `_web_search` +
   `_places_search` run CONCURRENTLY into a per-turn **blackboard** (a list on the
   instance, never a module global — concurrent tenants never share state).
4. **SIM (opt-in)** — `_population_sim()`: synthetic-stakeholder report folded into
   synth. Flag/param gated; failure just skips.
5. **DEBATE** — `_debate()`: each persona is an INDEPENDENT sub-LLM call
   (stance → challenge/support, real skepticism). Runs only when
   `plan.needs_debate` AND ≥2 participants. Lookups skip it.
6. **COMPLETION PASS** — when the task wants prospects/contacts and the board holds
   <3 PROSPECT rows: `_compose_places_queries()` (LLM) emits optimal Places queries
   (named-org lookups + `<category> in <region>` in the market's language) so the
   room sources real contacts itself instead of sealing `[to be sourced]`.
7. **SYNTH** — `_synthesize()`: strong model, CLEAN context (no tool transcript →
   no harmony glitch). Applies the skeleton (§5), rich-element menu (§6), identity
   pin, language directive, no-fabrication + finish-the-task contracts.
8. **SEAL** — emits the final `line`/synthesis event, reports token usage to Core.

Two engine entrypoints: `run_director(**kwargs)` (module fn Core-facing) →
instantiates `Director`. Prod runs the single-director path (`[single]` in logs).

## 3. Invariants — every one is a fixed prod incident

| Invariant | Failure it prevents |
|---|---|
| A new turn param goes in BOTH `run_director()` sig AND `Director.__init__` (+forward) | `run_director() got an unexpected keyword …` → EVERY turn seals 0-tok |
| `_company_identity_block()` pins "WE ARE <onboarded company>" | rooms adopted a client project's products (SOLVIS report signed by a SINGULANCE room) |
| Recall project scope enforced on the agent path too (Core `applyProjectScopeFilter`) | projectless chat leaked project KB; scoped chat wasn't restricted |
| Maps queries LLM-composed (`_compose_places_queries`); sanitizer = cost guard only | garbage Places calls ("PROSPECT QUALIFICATION Germany", full paragraphs) burning API |
| Discovery gated on planner `places_query` / `_wants_discovery(msg)` | Maps ran 20 firms on every outreach/strategy turn |
| Output language via `out_language` → `_lang_directive`, NEVER a message prefix | `[STRICT LANGUAGE:…]` prefix poisoned recall embeddings → 0 hits |
| No-fabrication + finish-the-task synth contracts | invented emails/numbers; `[to be sourced]` / "assign analyst by <date>" |
| Blackboard is per-instance | cross-tenant state bleed under concurrency |

## 4. Room kinds & shaping (`rooms/__init__.py`, `skills/`)

Canonical kinds: `hq, outreach, research(=market), strategy(+business+decision),
content, general`. `resolve_room_kind(task_tag, goal, message)` classifies.
`lead_shape_for(kind, intended_output)` → `maker | panel | auto`; maker kinds
(outreach/content/research/market that PRODUCE an output) get a maker lead,
skeptic panels only for strategy/decision. `shape_debate_members(members, shape)`
picks the roster (maker → makers[:2] + skeptic).

## 5. Method skills (`skills/`)

Per-kind `.md` playbooks loaded by `load_method_skill(name)`; `skill_catalog(kind)`
lists them; `default_skill_for(kind)` auto-loads one when the planner picked none.
Examples: outreach → `prospect-qualification`, `cold-email-sequence`,
`call-opening-script`. `api_outreach.py` reuses `cold-email-sequence` +
`polished-email` at send time so campaign emails are run-grounded, not generic.

Synth also injects a `_REPORT_SKELETON[kind]` (## section shape) — outreach = ICP →
Prospect List → Sequence → Success Metrics; strategy = DACI Decision → Options →
Rationale → Tripwire; etc. (`answer/doc/notion` outputs only).

## 6. Rich report elements (synth may emit; the FE renders each)

Fenced blocks: ` ```timeline `, ` ```stats ` (JSON), ` ```steps `, ` ```chart `
(JSON bar/line/donut), ` ```mermaid ` (branching flows only), and callouts
`> [!important|insight|risk|note]`. **Cadence rule:** a touch/email sequence is
ALWAYS a table or `steps`, never mermaid/chart. FE side: `frontend/Da-vinci/.../
hyperagents/rooms/` — `BrochureReport` (uniform per-kind view), `elements/index.jsx`
(the element library), `EmailElement` (typed letter). Every kind renders via a
brochure view — no legacy fallback.

## 7. Config — key `HYPER_*` env flags (all default-off / safe)

Models: `HYPER_DIRECTOR_MODEL`, `HYPER_PERSONA_MODEL`, `HYPER_OPENROUTER_PRIMARY`,
`HYPER_SYNTH_MAX_TOKENS`, `HYPER_SYNTH_TIMEOUT_S`, `HYPER_DEBATE_MAX_TOKENS`.
Gather: `HYPER_WEB_BUDGET`, `HYPER_GATHER_DEEPEN(_MAX_Q)`, `HYPER_CONNECTION_SEARCH`,
`HYPER_MCP_TOOLS_PER_CONNECTOR`, `HYPER_CONNECTOR_TOOL_CAP`, `GOOGLE_MAPS_API_KEY`
/`HYPER_PLACES_KEY`. Loops: `HYPER_SELF_REVISE(_MAX_CYCLES)`, `HYPER_DIGEST_*`,
`HYPER_JOURNAL_*`. Evolution: `HYPER_EVOLVE_ENABLED` + `HYPER_EVOLVE_*`
(episodic playbooks, dormant by default). Sim: `HYPER_SIM_*`.

## 8. Workflow & deploy

- Trunk-based per `/docs/BRANCH_PROTOCOL.md`: session branch → rebase onto
  `origin/singulance-main` → merge to `singulance-main` → deploy. Never commit
  feature work directly to trunk.
- Deploy: `quick-deploy.sh singulance-main` on `ssh singulance`; rebuild the
  `employees` service. Groq-primary; the box pins image tags — a `:latest` build
  must be retagged to the live `VERSION` if deploying a single service by hand.
- **Verify in-container**, always: `docker exec hm-employees grep -c <marker>
  /app/src/hivemind_employees/hyper/engine.py` and confirm
  `docker logs hm-employees | grep "director failed"` is empty.
- Before edits: `python3 -c "import ast; ast.parse(open('…/engine.py').read())"`.

## 9. Gotchas

- `run_director` vs `Director.__init__` param drift → 0-tok (see §3).
- Ad-hoc in-container `.mjs`/`.py` tests: bare imports resolve from `/app`, not `/tmp`.
- Recall through the agent path bypasses Core's `/api/recall` HTTP route — scope
  filtering must be applied at the tool layer (`applyProjectScopeFilter`), not
  assumed from the route.
- Org monthly token cap (plan-enforcer) returns 402 on writes when exhausted —
  seed org-canon via DB, not the API, when capped.
