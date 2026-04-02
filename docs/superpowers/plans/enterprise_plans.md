# Plan: Enterprise Teams for HIVEMIND

## Context

HIVEMIND needs Enterprise Teams: shared memory workspaces where org admins invite employees, each employee connects their own integrations (Gmail/Slack/GitHub) and chooses per-connector whether to sync to "My Space" (private) or "Team Workspace" (shared). The Memory Graph shows color-coded nodes per employee. CSI agents scan org-wide for cross-employee knowledge linking.

**What already exists**: User ↔ Org M2M with roles, Memory has userId + orgId + visibility enum, API keys scoped to user+org, UserOrganization has invitedAt/joinedAt, org.plan field, org.slug (unique).

**What doesn't exist**: Invite endpoints, shareable invite links, connector scope choice, per-user graph coloring, org-wide CSI, project channels, team management UI, Personal/Enterprise onboarding choice.

---

## Phase 1: Schema + Onboarding (Foundation)

### 1.1 Schema migration
**File**: `core/prisma/schema.prisma`

Add `OrgInvite` model:
```prisma
model OrgInvite {
  id        String    @id @default(uuid()) @db.Uuid
  orgId     String    @map("org_id") @db.Uuid
  email     String?
  role      String    @default("member")
  token     String    @unique
  expiresAt DateTime  @map("expires_at")
  usedAt    DateTime? @map("used_at")
  usedBy    String?   @map("used_by") @db.Uuid
  createdBy String    @map("created_by") @db.Uuid
  createdAt DateTime  @default(now()) @map("created_at")
  org       Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@map("org_invites")
}
```

Add `Project` model:
```prisma
model Project {
  id          String   @id @default(uuid()) @db.Uuid
  orgId       String   @map("org_id") @db.Uuid
  name        String
  slug        String
  description String?  @db.Text
  createdBy   String   @map("created_by") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  org         Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@unique([orgId, slug])
  @@map("projects")
}
```

Add to `PlatformIntegration`: `targetScope String @default("personal") @map("target_scope")`

Add relations to `Organization`: `invites OrgInvite[]`, `projects Project[]`

### 1.2 Onboarding: Personal vs Enterprise choice
**File**: `frontend/.../pages/Onboarding.jsx`

Replace single "Create Workspace" form with two-card choice:
- **Personal**: auto-creates org with `plan: 'free'`, redirects to dashboard
- **Enterprise**: shows name + slug input, creates org with `plan: 'enterprise'`

### 1.3 Update createOrg to accept plan + slug
**Files**: `frontend/.../shared/api-client.js`, `frontend/.../auth/AuthProvider.jsx`, `core/src/control-plane-server.js`

Pass `{ name, slug, plan }` through the chain. Control plane's `POST /v1/orgs` already handles slug; add `plan` to create data.

---

## Phase 2: Invite System (Team Growth)

### 2.1 Invite API endpoints
**File**: `core/src/control-plane-server.js`

- `POST /v1/orgs/:orgId/invites` — create invite (generates token, returns `/join/{slug}/{token}` URL)
- `GET /v1/orgs/:orgId/invites` — list pending invites
- `DELETE /v1/orgs/:orgId/invites/:id` — revoke invite
- `POST /v1/join/:token` — accept invite (auth required, creates UserOrganization, updates session)
- `GET /v1/orgs/:orgId/members` — list members with roles
- `PATCH /v1/orgs/:orgId/members/:userId` — change role
- `DELETE /v1/orgs/:orgId/members/:userId` — remove member

### 2.2 Join page
**New file**: `frontend/.../pages/JoinOrg.jsx`

Route: `/hivemind/join/:slug/:token` — checks auth, calls accept invite API, redirects to dashboard.

### 2.3 Team Members page
**New file**: `frontend/.../pages/TeamMembers.jsx`

Lists members, role badges, invite button (generates link or enters email), pending invites section.

### 2.4 Sidebar + routing
**Files**: `frontend/.../layout/Sidebar.jsx`, `frontend/.../app/HiveMindApp.jsx`

Add "Team" section (conditional on `org.plan === 'enterprise'`): Members, Projects. Add routes for team pages + join page.

### 2.5 API client methods
**File**: `frontend/.../shared/api-client.js`

Add: `listMembers`, `updateMemberRole`, `removeMember`, `createInvite`, `listInvites`, `revokeInvite`, `acceptInvite`

---

## Phase 3: Connector Scope + Org-Scoped Memories

### 3.1 Connector scope selector UI
**File**: `frontend/.../pages/Connectors.jsx`

When connecting, show: "Sync to: My Space / Team Workspace". Only show "Team" option when `org.plan === 'enterprise'`. Pass `target_scope` to OAuth start.

### 3.2 Backend: persist + apply targetScope
**Files**: `core/src/connectors/framework/connector-store.js`, `core/src/control-plane-server.js`

Store `targetScope` in PlatformIntegration. Pass through OAuth state.

### 3.3 Sync engine applies scope to memories
**File**: `core/src/connectors/framework/sync-engine.js`

When `targetScope === 'organization'`: set `orgId` + `visibility: 'organization'` on ingested memories.

### 3.4 Graph API supports team scope
**File**: `core/src/server.js`

Add `?scope=personal|team|all` to `/api/graph`. Team scope: filter by `orgId + visibility = 'organization'`.

---

## Phase 4: Memory Graph Team View + CSI Org-Wide

### 4.1 Per-user node coloring
**File**: `frontend/.../pages/MemoryGraph.jsx`

Add `USER_COLORS` palette. When scope is team/all, color nodes by `userId` instead of layer type. Add legend.

### 4.2 Scope filter toolbar
**File**: `frontend/.../pages/MemoryGraph.jsx`

Toggle buttons: My / Team / All. Project dropdown filter.

### 4.3 Graph API returns userId per node
**File**: `core/src/server.js`

Add `userId: r.userId` to node response (1-line change).

### 4.4 CSI org-wide scanning
**File**: `core/src/resident/faraday.js`

Support `scope: 'organization'` — scan all org memories without user_id filter. Add org-specific probes ("cross-employee duplicates", "organizational knowledge gaps").

### 4.5 Project CRUD endpoints
**File**: `core/src/control-plane-server.js`

CRUD for Project model. New page: `frontend/.../pages/TeamProjects.jsx`.

---

## Files Summary

| Phase | File | Action |
|-------|------|--------|
| 1 | `core/prisma/schema.prisma` | Modify: add OrgInvite, Project, targetScope |
| 1 | `frontend/.../pages/Onboarding.jsx` | Modify: Personal/Enterprise choice |
| 1 | `frontend/.../shared/api-client.js` | Modify: createOrg options |
| 1 | `frontend/.../auth/AuthProvider.jsx` | Modify: pass options |
| 1 | `core/src/control-plane-server.js` | Modify: accept plan in POST /v1/orgs |
| 2 | `core/src/control-plane-server.js` | Modify: invite/member/join endpoints |
| 2 | `frontend/.../pages/TeamMembers.jsx` | **New** |
| 2 | `frontend/.../pages/JoinOrg.jsx` | **New** |
| 2 | `frontend/.../layout/Sidebar.jsx` | Modify: Team section |
| 2 | `frontend/.../app/HiveMindApp.jsx` | Modify: team + join routes |
| 2 | `frontend/.../shared/api-client.js` | Modify: team API methods |
| 3 | `core/src/connectors/framework/connector-store.js` | Modify: targetScope |
| 3 | `core/src/connectors/framework/sync-engine.js` | Modify: scope on ingest |
| 3 | `core/src/control-plane-server.js` | Modify: OAuth state targetScope |
| 3 | `frontend/.../pages/Connectors.jsx` | Modify: scope selector |
| 3 | `core/src/server.js` | Modify: scope-aware graph query |
| 4 | `frontend/.../pages/MemoryGraph.jsx` | Modify: per-user colors, filter toggle |
| 4 | `core/src/server.js` | Modify: userId per graph node |
| 4 | `core/src/resident/faraday.js` | Modify: org scope support |
| 4 | `frontend/.../pages/TeamProjects.jsx` | **New** |
| 4 | `core/src/control-plane-server.js` | Modify: project CRUD |

## Verification

1. **Onboarding**: Login → see Personal/Enterprise choice → Enterprise creates org with slug
2. **Invite**: Admin generates link → copy URL → open incognito → login → auto-joins org
3. **Connector scope**: Connect Gmail → choose "Team Workspace" → ingest → memory has `visibility: organization`
4. **Memory Graph**: Toggle to "Team" → see color-coded nodes from multiple users
5. **CSI org-wide**: Run Faraday with `scope: organization` → finds cross-employee duplicates
6. **Projects**: Create project → assign members → memories filterable by project in graph
