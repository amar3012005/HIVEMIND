# Frontend Integration Status for Enterprise Provisioning

## ✅ Completed

### 1. Settings.jsx
- Added "Project Access Policy" configuration section
- Admin can set org-wide default: `private`, `team_inherited`, or `org_visible`
- Saves via `PATCH /api/team/org`

### 2. AdminUsers.jsx (/hivemind/app/admin/users)
- ✅ **InviteModal** now includes:
  - Email input
  - Role selection (multi-select)
  - **Team selection** (multi-select)
  - **Project selection** (multi-select) ← NEW
- ✅ Fetches and displays all org projects
- ✅ Sends `project_ids` and `team_ids` with invite

### 3. Backend server.js
- ✅ Invite creation accepts `teamIds` and `projectIds`
- ✅ Invite acceptance creates team + project memberships
- ✅ New `/api/auth/claim-invites` for first-login flow
- ✅ API key live entitlement resolution
- ✅ Project provisioning with policy-based auto-grant
- ✅ Audit logging for all operations

---

## ⚠️ API Routing Issue

The frontend and backend are currently **misaligned** on API endpoints:

### Frontend (api-client.js) calls:
```javascript
POST /v1/orgs/{orgId}/invites        // Control plane
POST /v1/join/{token}                // Control plane
GET  /v1/orgs/{orgId}/members        // Control plane
```

### Backend (server.js) implements:
```javascript
POST /api/team/invites               // Core API
POST /api/team/invites/:token/accept // Core API
POST /api/auth/claim-invites         // Core API
GET  /api/team/members               // Core API
```

### Solution Options:

**Option A: Update Control Plane Proxy** (Recommended)
Add proxy routes in control plane to forward to core API:
```
/v1/orgs/:orgId/invites   → /api/team/invites (with orgId from session)
/v1/join/:token           → /api/team/invites/:token/accept
/v1/orgs/:orgId/members   → /api/team/members
```

**Option B: Update Frontend API Client**
Change api-client.js to call core API directly for these operations:
```javascript
// Change from:
this.controlPlane.post(`/v1/orgs/${orgId}/invites`, payload)

// To:
this.core.post('/api/team/invites', payload)
```

---

## 🔄 Pages That Still Need Updates

### 1. TeamMembers.jsx (/hivemind/app/team/members)
**Current State:** Basic team member management (add/remove from team)

**Needs:**
- Show which projects each member has access to
- Quick-add member to project from this page
- Show pending invites for this team
- Display invite status (pending/accepted/expired)

### 2. TeamProjects.jsx (/hivemind/app/team/projects)
**Current State:** Create/list projects for active team

**Needs:**
- Show project access policy when creating project
- Display which team members have access to each project
- Quick-invite button to add members to specific project
- Show inherited vs. explicit access

### 3. First Login Flow (AuthProvider)
**Current State:** Standard OIDC login flow

**Needs:**
- After successful first login, automatically call:
  ```javascript
  POST /api/auth/claim-invites
  ```
- Show toast notification: "Welcome! You've been added to {N} teams and granted access to {M} projects"
- Redirect to onboarding or dashboard

---

## 📊 Feature Completeness Matrix

| Feature | Backend | Frontend UI | API Integration | Status |
|---------|---------|-------------|-----------------|--------|
| Invite with teams | ✅ | ✅ | ⚠️ Proxy needed | 80% |
| Invite with projects | ✅ | ✅ | ⚠️ Proxy needed | 80% |
| First-login claim | ✅ | ❌ Not wired | ⚠️ Proxy needed | 40% |
| API key project scope | ✅ | ❌ No UI yet | ✅ | 50% |
| Project policy | ✅ | ✅ Settings only | ✅ | 70% |
| Team-inherited access | ✅ | ❌ Not shown | ✅ | 60% |
| Audit logs | ✅ | ❌ No UI | ✅ | 60% |
| Member project view | ❌ | ❌ | ❌ | 0% |

---

## 🚀 Quick Wins (High Impact, Low Effort)

### 1. Wire First-Login Claim (30 min)
In `AuthProvider.jsx`, after successful login:
```javascript
// Check if first login
const loginCount = await apiClient.getLoginCount();
if (loginCount === 1) {
  const result = await apiClient.core.post('/api/auth/claim-invites');
  if (result.claimed > 0) {
    showToast(`Welcome! Added to ${result.claimed} organization(s)`);
  }
}
```

### 2. Add Control Plane Proxy Routes (1 hour)
Update control plane `server.js`:
```javascript
// Proxy invite operations to core
app.post('/v1/orgs/:orgId/invites', authenticate, async (req, res) => {
  const { teamIds, projectIds, email, role } = req.body;
  const coreResp = await coreApi.post('/api/team/invites', {
    email, role, teamIds, projectIds
  }, {
    headers: { 'X-HM-User-Id': req.userId, 'X-HM-Org-Id': req.params.orgId }
  });
  res.json(coreResp.data);
});
```

### 3. Show Project Count in TeamProjects (15 min)
In TeamProjects.jsx header, show:
```jsx
<p className="text-[12px] text-[#a3a3a3]">
  {projects.length} projects • {teamMemberCount} members with access
</p>
```

---

## 🎯 Next Steps (Priority Order)

1. **Add control plane proxy routes** for invite operations
2. **Wire first-login claim** in AuthProvider
3. **Test end-to-end flow**: Invite → Login → Claim → Access verified
4. **Add project member list** to TeamProjects page
5. **Show pending invites** in TeamMembers page
6. **Create API key UI** with project scope selector (Settings page)
7. **Add audit log viewer** for admins (new page or Settings section)

---

## 🔧 Testing Checklist

- [ ] Admin creates invite with teams + projects
- [ ] Invite email sent with proper token
- [ ] New user clicks invite link → redirects to login
- [ ] After first login, `/api/auth/claim-invites` is called
- [ ] User sees confirmation: "Added to N teams, M projects"
- [ ] User's API key works for granted projects
- [ ] Admin adds user to new team → access updates instantly
- [ ] Project with `team_inherited` policy auto-grants team members
- [ ] Audit logs record all operations

