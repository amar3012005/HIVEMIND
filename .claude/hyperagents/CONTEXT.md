# HyperAgents — Context (read this FIRST)

Single source of truth for the HIVEMIND **HyperAgents / Digital-Employees rooms**
subsystem. Any new session, on any device, reads this to get oriented in 2 minutes.
Pair with [JOURNAL.md](./JOURNAL.md) (what shipped, newest-first) and
[TODO.md](./TODO.md) (current phases). Deep code map: `core/HYPERAGENTS_CODEBASE_GUIDE.md`.

> Auto-engages via the `hyperagents-builder` skill. If you're reading this cold:
> the skill encodes the mandatory dev pipeline — follow it, don't freelance.

---

## What it is

Slack-style multi-agent rooms ("digital employees") that take a user request and
drive it to a real deliverable (answer / decision / doc / sheet / email) using the
org's HIVEMIND memory + live connectors (Gmail, Google Docs/Sheets, Drive; MCP later).
Personas + Cognitive-Swarm debate stay intact; the room follows a clean pipeline.

## The pipeline (THE mental model — every turn, every room template)

```
PLAN ─ GATHER ─ RECON-PRE ─ EXECUTE ─ SIMULATE ─ PRODUCE ─ RECON-POST ─ GOALKEEPER
```

| Phase | Function (`api_hyper_rooms.py`) | Does |
|------|------|------|
| PLAN | `_plan_turn` | Lead (in persona, tool-less) → `{intended_output, done_criterion, steps[], assignments{}, connectors_needed[]}`. Intent guard: planning/strategy Q → `answer`/`decision`, **never email** unless an explicit send-verb/address. |
| GATHER | `_gather_evidence` | Seeds evidence from **ALL** enabled sources in parallel (`asyncio.gather`): contact-resolution + topical `gmail_search` + `drive_search`; recall/web elsewhere. Recipient-gap → demote `email`→`answer` (never escalate). |
| RECON-PRE | `_recon_pre` | Evidence-sufficiency check before writing; flags gaps. |
| EXECUTE | `_execute_assignments` | **Each assigned owner does their slice in persona**, sequential handoff (builds on prior owners) = the phased deep interaction. Tool-less single-shot/owner, cap `HYPER_ROOM_EXECUTE_MAX_OWNERS=5`. Emits `execute` events. Runs for ANY template. |
| SIMULATE | `_orchestrate` debate loop / `_orchestrate_swarm` / `_orchestrate_deep_sim` | Team integrates + challenges the executed work → synthesis. |
| PRODUCE | `_produce_output` | ONE deterministic producer: doc→`docs_create`, sheet→`sheets_create`, email→`gmail_create_draft`+`queue_email_approval`. Idempotent. |
| RECON-POST | `_verify_turn` / `_verify_and_emit` | Verdict `{met, artifact_ok, assignments_ok, grounded_ok, gaps[]}` vs `done_criterion`. |
| GOALKEEPER | loop in `post_room_turn` | Reworks until met (or cap `HYPER_ROOM_GOALKEEPER_MAX_ROUNDS=3`). Loops only while `not met AND (not artifact_ok OR not grounded_ok)`; `reset_turn_outputs()` between rounds. Claude-`/goal`-style: work to success, never seal a known-flawed result. |

The plan is folded into `req.user_message` as a shared preamble (incl. gathered
evidence + executed work) so EVERY template/agent acts on it.

## Topology

```
React Room UI (Da-vinci submodule, Vercel/main)
  │ POST /v1/hyper-rooms/:id/turns → hm-control (control-plane-server.js :3000) → 202
  ▼ creates hyperTurn(status=live), fire-and-forget kick
hm-employees (Python FastAPI sidecar :8060) /internal/hyper/room-turn
  │ _orchestrate runs the pipeline; each event → POST /internal/hyper/turn-event
  ▼ appendTurnEvent → hyper_turns.lines (JSONB) = the event bus
FE reads SSE /turns/:id/stream (250ms poll) + GET fallback. Caddy needs flush_interval -1.
```

## File map

| File | Container | Owns |
|------|------|------|
| `employees-service/src/hivemind_employees/api_hyper_rooms.py` | hm-employees | The whole pipeline + all agent prompts. |
| `employees-service/src/hivemind_employees/agents/agentscope_tools.py` | hm-employees | Write-gate contextvars (`_WRITE_POLICY`/`_PENDING_WRITES`/`_OUTPUT_UNLOCKED`/`_TURN_ARTIFACTS`), `_gate_write`, `queue_email_approval`, `drain_*`, `reset_turn_outputs`, `record_artifact`. |
| `employees-service/src/hivemind_employees/hivemind_client.py` | hm-employees | `recall_emulated`, `org_members_emulated`, `google_exec_emulated` (master+emulation headers). |
| `core/src/connectors/google-native.js` | hm-core/hm-core-2 | `GOOGLE_TOOLS` (gmail_*/docs_*/sheets_*/drive_search), markdown→Docs renderer. |
| `core/src/control-plane-server.js` | hm-control + control-plane-s0k0 (2 replicas) | Turn/room routes, SSE handler, durable approve handler, `/internal/hyper/turn-event`. |
| `core/src/server.js` | hm-core/hm-core-2 | `/api/connectors/google/exec`, `/api/connectors/mcp/exec`, `/api/org/members`, `/api/recall`, `/api/memories`. **Avoid editing unless strictly required.** |
| `frontend/Da-vinci/src/components/hivemind/app/pages/HyperAgents.jsx` | Vercel | Room UI: SSE allowlist, `TurnView` renders plan/gather/recon_pre/execute/verify/approval/goalkeeper/connector_logo. |

**Two git repos:** core+sidecar = root `HIVEMIND` (push `main` = PROD). FE = `Da-vinci`
**submodule** (own repo, `main`→Vercel). Commit in the submodule, then bump the pointer
in the parent. Commit author ALWAYS `amarsai3012005 <amarsai3012005@users.noreply.github.com>`.

## Deploy (what actually works — main IS prod)

Box: `ssh root@116.202.24.69`. The reliable path used all session:

```bash
# sidecar (api_hyper_rooms.py / agentscope_tools.py / hivemind_client.py):
scp -q <path> root@116.202.24.69:/tmp/x.py
ssh root@116.202.24.69 'docker cp /tmp/x.py hm-employees:/app/src/hivemind_employees/<path> && docker restart hm-employees'
# core (google-native.js / control-plane-server.js): docker cp into hm-core AND hm-core-2 (both replicas!) / hm-control, then restart.
# NOTE: `docker cp` INTO hm-core is currently broken on this box ("/proc/self/fd") — write via `docker exec -i hm-core sh -c 'cat > path'` or base64, or restart from the bind-mount.
# FE: commit+push the Da-vinci submodule → Vercel auto-deploys main.
git push origin main   # parent → prod
```

Two core replicas share one BullMQ queue — restart BOTH `hm-core hm-core-2` or a stale replica processes half the jobs.

## Test harness (how to e2e a turn without the FE)

Fire the sidecar directly from inside the box network (master key + emulation):

```bash
TID=$(python3 -c 'import uuid;print(uuid.uuid4())')
ssh root@116.202.24.69 "docker exec hm-core sh -lc 'curl -s -m600 -X POST http://hm-employees:8060/internal/hyper/room-turn \
  -H \"X-API-Key: \$HIVEMIND_MASTER_API_KEY\" -H \"Content-Type: application/json\" -d @- <<JSON
{\"room_id\":\"<room>\",\"turn_id\":\"$TID\",\"user_id\":\"<uid>\",\"org_id\":\"<org>\",\"project_id\":<proj|null>,
 \"participant_ids\":[...],\"room_goal\":\"...\",\"user_message\":\"...\",
 \"callback_url\":\"http://hm-control:3000/internal/hyper/turn-event\"}
JSON'"
```
- The synchronous response carries `verification` + `pending_approvals` + `artifacts` — enough to judge without a DB row.
- Watch phases: `docker logs -f hm-employees | grep -E '\[plan\]|gather\]|recon-pre|execute\]|verify\]|goalkeeper'`.
- Get a room's `participantIds`/`enabledConnectors`/`goal` via `docker exec hm-core node -e '…prisma.hyperRoom.findUnique…'`.
- **Test email recipient is ALWAYS `amarsai2005@gmail.com`** (user-controlled, safe real send).
- Recall/save project-scope uses the project **UUID** (recall narrows on DB `project_id`); save with `project_ids:[uuid]`.

## Hard-won lessons (don't relearn these)

- **Recon agents / code-review-graph can be STALE.** A cartographer agent this session insisted GATHER/`google_exec_emulated`/`enabled_connectors` didn't exist — they all did. ALWAYS verify ground truth with `grep`/`Read` before trusting any recon (agent or graph) that claims something is absent.
- **Never fabricate a recipient.** Resolve via `org_directory`(org+Gmail) or trust a literal address the user typed (it IS the authorization). Unresolvable → demote to answer, don't escalate.
- **Match the sender's REAL voice** from their prior emails (`from:me … -in:drafts`), never the room's own AI drafts.
- **Goalkeeper must rework, not give up** — a recon-rejected draft loops; only `met` (or grounded+produced pending) seals.
- **Answer/decision outputs have no artifact** — the synthesis text IS the deliverable; verifier must not demand a doc/email for them.
- **Don't `synthesize-now` on a real org's KB** (destructive drift-compaction).
- Email is NEVER "sent" in-turn — draft + approval card; never claim sent.
- **Agents fabricate when tool-less. Tool-GROUND them.** Owners with `tools:["_exec_noop"]`/max_iters=1 invent specs, CEOs, citations, addresses with fake precision. Give them real tools (recall + connectors) + a bounded ReAct loop so they actually query. Pair with the GROUNDING GATE: `grounded_ok=false` → not saved (would poison recall), not RESOLVED. A confident claim with a fake source is the bug; an honest `UNVERIFIED` is fine.
- **Tool NAME ≠ gate key.** The registered recall tool is `recall` (the function name); `"hivemind_recall"` is only the `enabled_tool_names` gate key. NEVER hardcode a tool name in a prompt — say "use your recall/connector tools" — or Groq returns 400 `tool_use_failed: not in request.tools`.
- **Editing vs git cwd gotcha.** Edit/Read target `/Users/amar/HIVE-MIND/...` = the MAIN worktree (branch `main`, the live code). Bash `git` defaults to the `.claude/worktrees/suspicious-goldstine-65eaca` worktree (a STALE `claude/hermes-phase-6h` checkout, ~2700-line api_hyper_rooms.py). So commit code with `git -C /Users/amar/HIVE-MIND ...` and `grep` the file before trusting any `git diff` (a huge deletion diff = you're diffing the wrong worktree, not a real change).

## Key IDs (test org — leonardo@bundb.de)

- org `f5e2418b-61ef-4271-83a4-5623050b8402` · user `3b12845a-8cef-4174-ad89-16010810e90b`
- rooms: JEE/CNJE `e8d5e538-6eaf-4d7f-b7c5-bd4e17321f09` (gmail+google_docs); Singapore `9ce8355c-1267-4e5e-b068-5703124d3ea2`; Lyra×Aster `a1706e15-26e0-4cd3-b6f7-b01a76dfd933`
