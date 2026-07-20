# hyper/ — HyperAgents room engine (hm-employees Python sidecar)

Auto-loads when editing anything under `employees-service/src/hivemind_employees/hyper/`.
Full architecture + feature history: [`.claude/HYPERAGENTS.md`](.claude/HYPERAGENTS.md).
Read that before any non-trivial change here.

## What this is
The reasoning runtime behind HIVEMIND **Digital Employees / HyperAgents rooms**.
Core (Node) proxies a room turn here over HTTP; this service runs the multi-agent
turn and streams events back. `engine.py` is the whole engine (~2.6k lines, one
`Director` class); `rooms/` = per-kind shaping; `skills/` = method playbooks.

## The turn pipeline (`Director.run`, engine.py)
`_plan_gather` (fast planner LLM, structured JSON) → **event-driven router**:
`turn_mode:"chat"` short-circuits to `_chat_turn` (no tools). Else:
`_run_gather` (parallel recall + connectors + `_web_search` + `_places_search`)
→ optional `_population_sim` → `_debate` (personas as independent sub-LLM calls,
only when `plan.needs_debate`) → **completion pass** (`_compose_places_queries`
sources real contacts when the ask is prospects and the board is thin) →
`_synthesize` (strong model, clean context) → seal.

## Non-negotiable invariants (each = a past prod incident — see HYPERAGENTS.md)
- **Two entrypoints:** a new turn param must be added to BOTH `run_director()`
  (module fn) AND `Director.__init__` — else every turn seals 0-tok.
- **Company identity pin** (`_company_identity_block`): reports are BY the onboarded
  company; recalled memories may describe OTHER companies — never adopt them.
- **Maps queries are LLM-composed** (`_compose_places_queries`), never hand-built
  regex; the `_places_search` sanitizer is a cost guard only. Gate discovery on
  the planner's `places_query`/`_wants_discovery` — don't run Maps every turn.
- **Output language** (`_resolve_language` + `_lang_directive`) flows
  `run_director(out_language=)` → synth directive. Never prefix the user message.
- **No fabrication / finish-the-task**: synth contracts forbid invented
  contacts/numbers and `[to be sourced]` placeholders.

## Rules of the house
- Behavior changes are **env-flag gated + default-off** (see the `HYPER_*` flags).
- Groq-primary with OpenRouter failover; planner = fast/cheap model, synthesis =
  caller-chosen model (default gpt-oss-120b).
- `python3 -c "import ast; ast.parse(open('hyper/engine.py').read())"` before commit.
- Deploy is trunk-only: follow `/docs/BRANCH_PROTOCOL.md` (session branch → rebase
  → `singulance-main` → `quick-deploy.sh`; rebuild `employees` service).
- Verify in-container after deploy: `docker exec hm-employees grep -c <marker> …`
  and check `docker logs hm-employees | grep "director failed"` is empty.
