# Project Invites + Scoped save_memory

> **Status:** PLAN (not implemented). Owner: Amar. Date: 2026-05-28.

## Goal

Let an org admin invite a human teammate to a specific Project (not just the org).
After OAuth-style accept, that user becomes a `ProjectMember`. From then on
their MCP `hivemind_save_memory` calls become project-aware: if `project_id`
is omitted and they belong to ≥2 projects, the MCP returns a clarifying
question instead of silently saving to the global bucket.

Non-goals: Digital Employees / Hyper Agents (they're bot rows, not invitees).

---

## 1. Existing infra to reuse (do NOT rebuild)

| Piece | Where |
|---|---|
| `OrgInvite` row w/ `projectIds[]`, `teamIds[]`, token, expiry | `schema.prisma` L108 |
| Invite send + email | `control-plane-server.js` ~L1860 (`/hivemind/join/<slug>/<token>`) |
| Accept flow (token → membership) | same |
| `ProjectMember` model | `schema.prisma` L204 |
| `ShareInviteModal.jsx` | frontend, exists |
| `TeamProjects.jsx` / `WorkspaceAdmin.jsx` | frontend pages |
| `hivemind_save_memory` MCP tool | `core/src/server.js` ~L17117 + memory engine |

---

## 2. Gaps to close

### 2.1 Invite UX — project scope

`OrgInvite.projectIds[]` already exists but the create-invite UI sends org-wide
invites only. Need:

- `ShareInviteModal` gains "Invite to project: <picker>" — populates `projectIds`.
- Existing email template includes project name(s) in subject/body when present.

### 2.2 Accept screen — OAuth-style consent

Current `/hivemind/join/<slug>/<token>` accept = generic org join. Add:

- If `invite.projectIds.length > 0` → fetch each project's `{name, description, memberCount}`.
- Render consent card:

```
You've been invited to join project: <Project Name>
"<Project description>"
Org: <Org Name>     Invited by: <Inviter Name>
Scope you'll get: read+write memories in this project.

[ Decline ]   [ Accept and join ]
```

- Accept → create `ProjectMember(projectId, userId)` rows for each id in `invite.projectIds` (in addition to existing `OrgMember` provisioning).
- Decline → mark invite revoked.

### 2.3 save_memory — project-aware routing

Current MCP `hivemind_save_memory({title, content, tags, project_id?})`:
- if `project_id` set → save scoped
- if absent → save global (or last-used)

New logic (server-side, no client change):

```
on save_memory(userId, project_id?):
  projects = ProjectMember.find({ userId })           # user's memberships
  if project_id:
    assert project_id ∈ projects (else 403)
    save → done
  if projects.length == 0:
    save global → done                                # current behavior
  if projects.length == 1:
    save → projects[0]                                # auto-attach
  if projects.length >= 2:
    # First time after a new project was added: nudge once.
    if user has unseen new project P:
      return { needs_choice: true, prompt: "New project '<P>' available. Default save here?", choices: [P, "ask each time"] }
      mark P as seen for this user
    else:
      return { needs_choice: true, prompt: "Save to which project?", choices: projects }
```

**Return shape on clarification:** structured MCP response, NOT a save. Agent surfaces choice to the human; human picks; agent re-calls save_memory with `project_id`.

**"Unseen new project" tracking:** new column

```sql
ALTER TABLE project_members ADD COLUMN seen_at TIMESTAMPTZ DEFAULT NULL;
```

`seen_at = NULL` → next save_memory triggers nudge, then sets `seen_at = now()`.

### 2.4 user_id scoping

- All reads filter by `userId` via `ProjectMember`.
- Memory write stamps `project_id` + `user_id` (existing).
- Org admins can see project members but each user's project list is computed from `ProjectMember WHERE userId = X`.

---

## 3. Files to touch

| File | Change |
|---|---|
| `frontend/Da-vinci/src/components/hivemind/app/components/ShareInviteModal.jsx` | add project picker, pass `projectIds` |
| `frontend/Da-vinci/src/components/hivemind/app/pages/Join.jsx` (or wherever `/hivemind/join/...` renders) | consent screen when `projectIds.length > 0` |
| `core/src/control-plane-server.js` invite create | accept `projectIds` from body |
| same, invite accept handler | provision `ProjectMember` rows |
| `core/prisma/schema.prisma` | add `ProjectMember.seenAt` |
| `core/prisma/migrations/<date>_project_member_seen_at/migration.sql` | new migration |
| `core/src/server.js` save_memory handler | add project-aware branch |
| `core/src/memory/...` (save path) | accept `project_id`, enforce membership |

---

## 4. Phases

**Phase 1 — Invite project-scope (FE + CP)**
- ShareInviteModal picker
- Accept screen consent card
- Provision ProjectMember on accept
- Verify: invite a test user → accept → row in `project_members`

**Phase 2 — save_memory routing**
- Migration: `project_members.seen_at`
- Server logic: enforce membership + clarification response
- MCP contract: document `needs_choice` response shape
- Verify: curl save_memory with 2 projects → returns clarification; with `project_id` → saves

**Phase 3 — New-project nudge**
- One-time nudge on first save after new membership
- Mark `seen_at`
- Verify: accept invite → next save_memory shows nudge once → subsequent calls use plain clarification flow

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Breaking existing save_memory callers expecting silent save | Only change behavior when user has ≥2 projects; single-project + global users unaffected |
| `needs_choice` response not handled by older agents | Document MCP shape; agents that ignore it fall back to global save (no data loss) |
| Membership check on every save adds latency | Cache `ProjectMember.findMany({userId})` per request session |
| Invite token reuse to join multiple projects | Existing token model is single-use; one invite = one project set |

---

## 6. Open questions

1. Should an org admin be able to add an existing org member directly to a project (no email invite)? Probably yes — separate "Add member" button on project page, no token flow.
2. If user is in many projects (>5), is a dropdown OK or do they need tag-based default-per-context? Defer.
3. Should Digital Employees also have project membership? Out of scope here; existing `digital_employees.team_id` / `scope` may already cover.
