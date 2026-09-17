---
name: agentscope-agent-team
description: "Compose AgentScope 2.0.8 agent teams for HIVEMIND Digital Employees — leader/worker topology, the built-in TeamCreate/AgentCreate/TeamSay/AgentInvite/TeamDelete tools, custom sub-agent templates mapped to employee roles, permission modes (EXPLORE vs full access), invitation scope, and how team coordination maps onto delegated WorkRuns. Invoke BEFORE writing team, delegation, or worker-role code, and before registering sub-agent templates."
---

# Agent teams — delegating a WorkRun across many agents

An agent team is not a separate framework. A **leader** session (the one the user
talks to) spawns **worker** sessions and exchanges messages with them; every
member is just another session with its own state, workspace binding, and event
stream. Four built-in tools express the whole coordination story.

**Announce:** "Using agentscope-agent-team."

Load `.claude/skills/agentscope-runtime/CONTRACT.md` and
`references/TEAM_CONTRACT.md` first.

## Concepts

| Concept | Meaning |
| --- | --- |
| **Team** | persistent group of members owned by one user (`TeamRecord`) |
| **Leader** | the session that created the team; sole authority to add/remove members or end it |
| **Worker** | a session spawned as a member; own ReAct loop, own stream, inherits leader's model + workspace context |
| **Team message** | routed through the message bus, delivered as a `HintBlock` in `<team-message from="…">` |

## Built-in tools

| Tool | Who sees it | Purpose |
| --- | --- | --- |
| `TeamCreate` | leader | create a team rooted at this session; become leader |
| `AgentCreate` | leader | spawn a worker (name, role, first task, permission mode) — **it starts working immediately** |
| `TeamSay` | **everyone** (leader + workers) | message a member, or broadcast |
| `AgentInvite` | leader | bring an existing agent into the team (creates a session for it) |
| `TeamDelete` | leader | dissolve the team and clean up member sessions |

Workers see **only `TeamSay`**. They cannot spawn more workers — flat topology by
design.

**Deletion semantics differ by origin:**

- Agents created with `AgentCreate` are **permanently deleted** on `TeamDelete`.
- Agents brought in with `AgentInvite` are **not deleted** — only the team
  association is removed. They keep their own workspace and lifecycle, which is
  unaffected by dissolution.

So: transient roles → `AgentCreate`. Long-lived employees → `AgentInvite`.

## Custom sub-agent templates — the employee-role mapping

This is how HIVEMIND employee roles get distinct capabilities. A template defines
a sub-agent **type** with a pre-configured prompt, permission context, and task
context; registering templates makes `AgentCreate` expose a `subagent_type`
parameter the leader can route on.

```python
from agentscope.app import create_app, SubAgentTemplate
from agentscope.permission import PermissionContext, PermissionMode

app = create_app(
    storage=storage,
    message_bus=message_bus,
    workspace_manager=workspace_manager,
    custom_subagent_templates=[                       # <-- verified name
        SubAgentTemplate(
            type="researcher",
            description=(
                "Read-only agents specialized in investigation. Use this type "
                "when you need to gather and verify information without "
                "changing anything."
            ),
            system_prompt_template=(
                "You are {member_name}, a researcher in team '{team_name}' "
                "led by {leader_name}.\n\nTeam purpose: {team_description}\n\n"
                "Your role: {member_description}\n\n"
                "Report back to {leader_name} with TeamSay, success or failure."
            ),
            permission_context=PermissionContext(mode=PermissionMode.EXPLORE),
        ),
        SubAgentTemplate(
            type="writer",
            description="Full-access agents that produce final deliverables.",
            system_prompt_template="You are {member_name} in team '{team_name}'.",
            permission_context=PermissionContext(),   # default: full access
        ),
    ],
)
```

### ⚠ The parameter name is `custom_subagent_templates`

The public documentation calls it **`sub_agent_templates`**. That name does not
exist in the source. Because `create_app` accepts `**kwargs`, the wrong name is
**swallowed silently**:

- no error, no warning, no log;
- templates never register;
- `AgentCreate` never gains `subagent_type`;
- the leader silently falls back to one undifferentiated default worker.

**The failure is invisible until you notice workers behaving identically.**
Confirm with `verify_api_surface.py` before and after wiring templates.

```bash
grep -rn "sub_agent_templates" ~/agentscope/src/agentscope/        # → no matches
grep -rn "custom_subagent_templates" ~/agentscope/src/agentscope/  # → matches
```

### Template fields

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| `type` | ✅ | — | becomes an `AgentCreate` `subagent_type` enum value |
| `description` | ✅ | — | shown **to the leader model** so it can choose — write it as routing guidance |
| `system_prompt_template` | ✅ | — | format string; placeholders below |
| `permission_context` | — | `PermissionContext()` | e.g. `PermissionMode.EXPLORE` for read-only |
| `context_config` | — | `ContextConfig()` | context-window config |
| `react_config` | — | `ReActConfig()` | ReAct loop config |
| `tasks_context` | — | `TaskContext()` | can seed an initial workflow |

Placeholders available in `system_prompt_template`: `{team_name}`,
`{team_description}`, `{member_name}`, `{member_description}`, `{leader_name}`.

Runtime behaviour:

- **No templates registered** → `AgentCreate` does **not expose** `subagent_type`
  at all (keeps the schema clean).
- **Templates registered** → `AgentCreate` gains the enum, always including
  `"default"`.
- Registering `type="default"` **replaces** the built-in default template.
- **Duplicate `type` values raise `ValueError` at startup** — fail fast, good.

> `description` is not documentation — it is **prompt text the leader reads to
> pick a worker type**. Vague descriptions produce misrouted work.

## Invitation scope

`AgentInvite` builds its candidate pool from agents **visible** to the leader
(its own + those granted by the resource access policy), filtered to those with
`Invitable` set and a non-empty `Invite description`. **If the pool is empty the
leader does not receive the `AgentInvite` tool at all** — a silent capability
absence rather than an error.

When another user's agent is invited, the borrowed session takes its **workspace
and model from the caller's own** session of that agent, so it never inherits the
owner's MCPs, skills, cache, or session permissions. The agent *definition*
(system prompt, context, ReAct config) still comes from the original record.
Access is re-resolved at invite time — an invite fails if access was revoked.

## How coordination actually works

Distributed by default. The leader is **not** a parent coroutine; workers run
**concurrently** in their own sessions:

1. A tool call (`TeamSay`, `AgentCreate`'s initial prompt) pushes a `HintBlock`
   onto the recipient's inbox via the message bus.
2. A wakeup is enqueued for the recipient.
3. A wakeup dispatcher on **any** process claims it and drives `ChatService.run`.
4. `InboxMiddleware` drains the inbox before the next reasoning step, so the
   message lands in the recipient's context.

Consequences for HIVEMIND integration:

- Leader and workers may be on **different processes/nodes** — no code change.
- The leader observes a worker by reading its stream or by receiving a `TeamSay`.
- **You cannot assume ordering** between a worker's stream output and the
  leader's summary. If hm-core needs deterministic completion, require workers to
  `TeamSay` an explicit terminal status and gate on that.
- `TeamDelete` cleans up member sessions — with `AgentCreate` workers, their state
  is gone. Persist anything that must survive **outside** the team (into HIVE-MIND)
  before dissolution.

## Team ↔ WorkRun mapping

| AgentScope | HIVEMIND |
| --- | --- |
| leader session | the WorkRun's primary session |
| `AgentCreate` worker | a **delegated sub-task** of the WorkRun — ephemeral |
| `AgentInvite`d agent | a **named employee** persisted in hm-core |
| `TeamSay` | the delegation/report channel |
| `TeamDelete` | WorkRun completion (persist artifacts first) |

Because a team is scoped to one `user_id`, and hm-core's `user_id` is the tenant
boundary, a team never spans orgs. If a WorkRun needs cross-org collaboration,
that is a sharing-policy concern, not a team concern.

## Checklist

- [ ] Templates registered via **`custom_subagent_templates`** — never `sub_agent_templates`.
- [ ] `verify_api_surface.py` passes **and** `AgentCreate` exposes `subagent_type` at runtime.
- [ ] Each template `description` reads as routing guidance for the leader model.
- [ ] Duplicate `type` values absent (would `ValueError` at startup).
- [ ] Read-only roles use `PermissionMode.EXPLORE`; verify a worker actually cannot write.
- [ ] Transient work uses `AgentCreate`; persistent employees use `AgentInvite`.
- [ ] Artifacts persisted to HIVE-MIND **before** `TeamDelete`.
- [ ] Terminal status reported via `TeamSay` if hm-core gates on completion.
- [ ] Verified by a real run: workers show differentiated behaviour per `subagent_type`.

## See also

- `references/TEAM_CONTRACT.md` — full tool/template reference.
- `../agentscope-agent-service/SKILL.md` — sessions, bus, and the SSE stream.
- `CONTRACT.md` §7 — the doc-drift table.
