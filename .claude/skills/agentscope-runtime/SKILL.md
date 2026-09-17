---
name: agentscope-runtime
description: "AUTO-USE for ANY work on the HIVEMIND/SINGULANCE agent execution stack built on AgentScope 2.0.x — provisioning the agent runtime, wiring hm-core identity/org/policy/WorkRun into an AgentScope Agent Service, choosing a workspace/sandbox backend, composing agent teams, or adding MCP/skill hubs. Invoke BEFORE writing or changing any agent-runtime code, and BEFORE answering any question about how employees, WorkRuns, capability runtimes, or sandboxes are hosted. This is the umbrella entry point; it routes to the five focused skills."
---

# AgentScope Runtime — umbrella router

**AgentScope 2.0.8 is the execution substrate for HIVEMIND Digital Employees.** The
architecture is already agreed; the job of this skill set is to build it on
AgentScope **core features**, never on legacy patchwork. Do not hand-roll a
session store, scheduler, team coordinator, sandbox pool, or MCP loader that
AgentScope already ships.

**Announce:** "Using agentscope-runtime — routing to <skill>."

## STEP 0 — Load context (every time, before anything else)

1. `.claude/skills/agentscope-runtime/CONTRACT.md` — the **authoritative, source-verified** API surface. Read it first; it overrides any recollection or doc page, and it records two places where the public docs are *wrong*.
2. `.claude/skills/agentscope-runtime/reference/agentstack-architecture.md` — the target topology, layer responsibilities, and build order.
3. `AGENTS.md` — the AUTONOMY / ARCHITECTURE / GENERALITY contracts and the release rules. Domain knowledge lives in playbook **data**; the engine stays domain-agnostic.

Then state which skill you routed to and why.

## The target stack (what "building this" means)

```
SINGULANCE  (Web · Desktop · Mobile)
        │  command / event API
        ▼
hm-core  ── identity · org/tenancy · employees · Hive Mind memory ·
            policy · approvals · billing · connectors · artifacts · WorkRuns
        │  WorkRun (the unit of work handed down)
        ▼
AgentScope Agent Service ── sessions · schedules · background jobs ·
            resume · reasoning · delegation · agent teams
        │  capability runtime
        ├── HIVE-MIND Meta Tools        (memory / recall / connectors as tools)
        ├── Connectors / MCP            (per-workspace MCP clients)
        └── Workspace / Sandbox         (E2B · Docker · Apple Container · K8s)
        │
        ▼
Artifact layer ── HTML · PDF · Images · Video ──▶ back into HIVE-MIND
```

**The seam that matters:** hm-core owns `identity/org/policy/billing`; AgentScope
owns `sessions/schedules/teams/workspaces`. hm-core hands down a **WorkRun**;
AgentScope hosts the run and streams events back. Any code that puts org policy
logic inside an AgentScope agent — or puts session/scheduler state inside
hm-core — has violated the boundary.

## Routing table

| If the task is… | Load this skill |
| --- | --- |
| Boot/embed the service, `create_app`, storage, auth, schemas, models, SSE, the API | `.claude/skills/agentscope-agent-service/SKILL.md` |
| Workspace/sandbox backends, isolation grain, artefact output, long-running processes, E2B/Docker/K8s | `.claude/skills/agentscope-workspace-sandbox/SKILL.md` |
| Single agent vs Agent Team, `TeamCreate`/`AgentCreate`, sub-agent templates, delegation | `.claude/skills/agentscope-agent-team/SKILL.md` |
| MCP + skill hubs, connector/registry installation, connector ↔ MCP mapping | `.claude/skills/agentscope-hubs/SKILL.md` |
| Cross-cutting: version drift, param-name drift, what to never build | this file + `CONTRACT.md` |

Details live in each skill's `references/` (`core-api.md`,
`WORKSPACE_SANDBOX_CONTRACT.md`, `TEAM_CONTRACT.md`, `HUB_CONTRACT.md`).

## The build order (setup first — this is a build guide, not only a reference)

Phase 0 is mandatory; every later phase assumes it.

```
0. Boot a local instance            → the cloned repo has main.py ready
   venv + `uv pip install -e ".[full]"` + redis + `python main.py`
   VERIFY the API surface: `.claude/skills/agentscope-runtime/verify_api_surface.py`
1. Service shell                    → agentscope-agent-service
   create_app with storage + bus + workspace_manager; keep X-User-ID stub for dev
2. Workspace/sandbox backends       → agentscope-workspace-sandbox
   Local for dev → Apple Container / Docker for one box → E2B/K8s when scaling out
3. Capability runtime               → agentscope-hubs
   HIVE-MIND Meta Tools as agent tools; connectors as MCP; hubs for installation
4. Agent + team layer               → agentscope-agent-team
   sub-agent templates for employee roles; teams for delegated WorkRuns
5. hm-core integration              → agentscope-agent-service (integration section)
   real auth replacing X-User-ID; WorkRun → session; events → hm-core
6. Artefacts                        → agentscope-workspace-sandbox (artifact section)
   HTML/PDF/Images/Video emitted into the workspace, registered back to HIVE-MIND
```

**Do not start a later phase to compensate for an unverified earlier one.** Each
phase ends with a concrete check (a `curl`, a stream assertion, a file on disk),
and the evidence is recorded — prose is never completion evidence.

## Non-negotiables

- **Core features over patchwork.** If you are about to write a scheduler, a
  session store, a team message router, a sandbox manager, or an MCP loader —
  stop; AgentScope ships it. Check `CONTRACT.md` first.
- **Source beats docs.** Verify every symbol against `CONTRACT.md` (source-derived)
  or by reading `~/agentscope/src/agentscope/…`. Two documented names are wrong; see below.
- **Pin the version.** State 2.0.8 whenever giving install commands. Never mix 1.x
  and 2.x APIs; never follow `/latest/` docs against a pinned source.
- **Generality contract applies.** No `if company == …`, no hard-coded stage/skill/
  channel names in engine code. Domain knowledge is versioned playbook data.
- **One process owns timers and one owns channels.** `enable_scheduler=True` on
  exactly one replica; `enable_channel_worker=True` on exactly one. Get this wrong
  and cron fires N× or bots double-post.
- **`download_secret` must be set behind a load balancer.** The per-process default
  makes download tokens fail at random across replicas.
- **Replace `X-User-ID` before any deployment.** It is a placeholder with zero
  authentication.

## Known doc-vs-source drift (verified 2026-09-17)

These are the traps that produce silent breakage. Both are confirmed by reading
`~/agentscope/src/agentscope/`.

| Public doc says | Source actually is | Consequence |
| --- | --- | --- |
| `create_app(sub_agent_templates=[…])` | `create_app(custom_subagent_templates=[…])` | The documented kwarg is swallowed by `**kwargs` and **silently ignored** — templates never register, `AgentCreate` never gains `subagent_type`, and the leader cannot route roles. No error. |
| `create_app(sub_agent_templates=…)` (agent-team page) | same as above | same silent failure |

There is no `sub_agent_templates` parameter. `create_app` accepts `**kwargs` for
forward compatibility, so a wrong name does **not** raise — it quietly does
nothing. Always confirm with `verify_api_surface.py`.

## Verification is mandatory

Run before trusting any generated code:

```bash
python .claude/skills/agentscope-runtime/verify_api_surface.py
```

It asserts every symbol this skill set documents exists in the installed
AgentScope, and flags the drift table above. A green run is the only acceptable
evidence that the skill set matches the runtime.

## See also

- `CONTRACT.md` — authoritative symbol table (source-derived).
- `reference/agentstack-architecture.md` — full topology, layer boundaries, build order.
- `reference/verification-log.md` — **review log** of every claim in this skill set, each marked *independently verified* or *needs review*, with the exact check used.
