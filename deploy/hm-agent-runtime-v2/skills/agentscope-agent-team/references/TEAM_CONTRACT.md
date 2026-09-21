# TEAM_CONTRACT

Source-verified reference for AgentScope 2.0.8 agent teams.
Verify with `../../agentscope-runtime/verify_api_surface.py`.

## Built-in tools

| Tool | Available to | Purpose |
| --- | --- | --- |
| `TeamCreate` | leader | create a team rooted at the current session; the caller becomes leader |
| `AgentCreate` | leader | spawn a worker with name, role description, first task, permission mode. **Starts executing immediately.** |
| `TeamSay` | leader **and** workers | send a message to a named member, or broadcast |
| `AgentInvite` | leader | invite an existing agent into the team; a new session is created for it |
| `TeamDelete` | leader only | dissolve the team and clean up member sessions |

**Workers see only `TeamSay`.** Flat topology — workers cannot spawn workers.

`AgentInvite` is **absent entirely** when the candidate pool is empty (no visible
agent has `Invitable` set with a non-empty `Invite description`). A silent
capability absence, not an error.

## Sub-agent templates

```python
from agentscope.app import create_app, SubAgentTemplate
from agentscope.permission import PermissionContext, PermissionMode
```

### ⚠ Parameter name

```python
create_app(custom_subagent_templates=[...])   # correct (source)
create_app(sub_agent_templates=[...])         # WRONG — docs only; silently ignored
```

`sub_agent_templates` does not exist. `create_app(**kwargs)` swallows the typo:
no exception, no warning, templates simply never register, `AgentCreate` never
gains `subagent_type`, and every worker falls back to the same default.

### Template fields

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| `type` | ✅ | — | template identifier; becomes an enum value of `AgentCreate`'s `subagent_type` |
| `description` | ✅ | — | **exposed to the leader model** in the `AgentCreate` tool schema — routing guidance |
| `system_prompt_template` | ✅ | — | Python format string; placeholders below |
| `permission_context` | — | `PermissionContext()` | controls what the worker may do |
| `context_config` | — | `ContextConfig()` | context-window configuration |
| `react_config` | — | `ReActConfig()` | ReAct loop configuration |
| `tasks_context` | — | `TaskContext()` | can seed an initial workflow |

### System prompt placeholders

| Placeholder | Value |
| --- | --- |
| `{team_name}` | team name set by `TeamCreate` |
| `{team_description}` | team description set by `TeamCreate` |
| `{member_name}` | worker name set by `AgentCreate` |
| `{member_description}` | worker role description set by `AgentCreate` |
| `{leader_name}` | leader agent's display name |

### Runtime behaviour

| Situation | Result |
| --- | --- |
| No templates registered | `AgentCreate` does **not** expose `subagent_type` at all — schema stays clean |
| Templates registered | `AgentCreate` gains the enum, always including `"default"` |
| A template with `type="default"` registered | **Replaces** the built-in default template entirely |
| Duplicate `type` values | `ValueError` **at startup** |

### Permission modes

```python
PermissionContext(mode=PermissionMode.EXPLORE)   # read-only worker
PermissionContext()                              # default: full access
```

Use `EXPLORE` for research/analysis roles and the default for roles that must
write files or run mutating tools.

## Invitation scope

Set on the agent record when creating/editing an agent:

- **`Invitable`** — whether other agents may invite this one.
- **`Invite description`** — shown to the leader when choosing whom to invite.

**Both are required** for an agent to enter the candidate pool.

Pool = agents visible to the leader (its own + those granted by the resource
access policy) ∩ `Invitable` ∧ non-empty `Invite description`.

When another user's agent is invited:

- the borrowed session takes its **workspace and model from the caller's own**
  session of that agent — it never inherits the owner's MCPs, skills, cache, or
  session permissions;
- the agent **definition** (system prompt, context config, ReAct config) still
  comes from the original record;
- the target is resolved against the sharing policy **again at invite time**, so
  an invite fails if access was revoked in the meantime.

## Deletion semantics

| Member origin | On `TeamDelete` |
| --- | --- |
| `AgentCreate` worker | **permanently deleted** |
| `AgentInvite`d agent | **not affected** — only the team association is removed; its own workspace and lifecycle persist |

**Persist anything that must survive into HIVE-MIND before dissolving the team.**

## Coordination model

Distributed by default; the leader is not a parent coroutine.

```
sender tool call (TeamSay / AgentCreate initial prompt)
        │
        ├─► push HintBlock onto recipient session's inbox   (message bus)
        └─► enqueue wakeup for recipient                    (message bus)
                    │
                    ▼
        any process's wakeup dispatcher claims the wakeup
                    │
                    ▼
        ChatService.run drives the recipient session
                    │
                    ▼
        InboxMiddleware drains the inbox before the next
        reasoning step → HintBlocks land as HintBlockEvents
```

Team messages are wrapped as `<team-message from="…">` so the recipient's model
can distinguish them from a user turn.

Implications:

- Leader and workers may live in **different processes or nodes** with no code change.
- Workers run **concurrently**; they are not nested under the leader.
- The leader observes a worker by reading its session stream or by receiving a
  `TeamSay`.
- **Ordering between a worker's stream and the leader's summary is not
  guaranteed.** For deterministic completion, require a terminal `TeamSay` status
  and gate on that.

## Team ↔ WorkRun mapping

| AgentScope | HIVEMIND |
| --- | --- |
| leader session | the WorkRun's primary session |
| `AgentCreate` worker | an ephemeral delegated sub-task |
| `AgentInvite`d agent | a named employee persisted in hm-core |
| `TeamSay` | delegation / report channel |
| `TeamDelete` | WorkRun completion (persist artifacts first) |

A team is scoped to one `user_id`. Since hm-core's `user_id` is the tenant
boundary, **a team never spans orgs** — cross-org collaboration is a sharing-policy
concern, not a team concern.

## Verification checklist

```bash
grep -rn "sub_agent_templates" ~/agentscope/src/agentscope/        # must be empty
grep -rn "custom_subagent_templates" ~/agentscope/src/agentscope/  # must match
```

Then at runtime: confirm `AgentCreate` exposes a `subagent_type` parameter, and
that two workers of different types behave differently. If all workers behave
identically, the templates did not register — suspect the parameter name first.
