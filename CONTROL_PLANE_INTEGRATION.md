# 🔧 Control Plane Integration Guide

## Problem Statement

The frontend pages are now updated to use the new enterprise provisioning features, but there's a **routing mismatch** preventing end-to-end functionality:

```
Frontend (api-client.js)          Backend (server.js)
├─ /v1/orgs/:id/invites      ✗   /api/team/invites
├─ /v1/join/:token           ✗   /api/team/invites/:token/accept  
├─ /v1/orgs/:id/members      ✗   /api/team/members
└─ /v1/orgs/:id/projects     ✗   /api/team/projects
```

## Solution: Add Control Plane Proxy Routes

### File to Modify: `control-plane/src/server.js`

Add these proxy routes to forward requests from control plane to core API:

```javascript
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Team & Project Invites (Enterprise Provisioning)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const axios = require('axios');

// Core API client (reusable)
const coreApi = axios.create({
  baseURL: process.env.CORE_API_BASE_URL || 'https://hivemind.davinciai.eu',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' }
});

/**
 * POST /v1/orgs/:orgId/invites
 * Create invite with optional team and project scope
 * 
 * Body:
 *   email: string
 *   roles: string[]
 *   team_ids?: string[]   // optional
 *   project_ids?: string[] // optional
 */
app.post('/v1/orgs/:orgId/invites', authenticate, async (req, res, next) => {
  try {
    const { orgId } = req.params;
    const { email, roles, team_ids, project_ids } = req.body;

    // Validate user is admin in this org
    if (!req.user || !req.user.orgRoles?.[orgId]?.includes('org_admin')) {
      return res.status(403).json({ error: 'Only org admins can create invites' });
    }

    // Map to core API format (teamIds, projectIds instead of team_ids, project_ids)
    const coreResp = await coreApi.post('/api/team/invites', {
      email,
      role: roles?.[0] || 'member', // core expects single role
      teamIds: team_ids || [],
      projectIds: project_ids || []
    }, {
      headers: {
        'X-HM-User-Id': req.user.id,
        'X-HM-Org-Id': orgId,
        'Cookie': req.headers.cookie // forward session
      }
    });

    res.json(coreResp.data);
  } catch (err) {
    console.error('[Proxy] Error creating invite:', err.message);
    if (err.response) {
      return res.status(err.response.status).json(err.response.data);
    }
    next(err);
  }
});

/**
 * GET /v1/orgs/:orgId/invites
 * List pending invites for org
 */
app.get('/v1/orgs/:orgId/invites', authenticate, async (req, res, next) => {
  try {
    const { orgId } = req.params;

    const coreResp = await coreApi.get('/api/team/invites', {
      headers: {
        'X-HM-User-Id': req.user.id,
        'X-HM-Org-Id': orgId,
        'Cookie': req.headers.cookie
      }
    });

    res.json(coreResp.data);
  } catch (err) {
    console.error('[Proxy] Error listing invites:', err.message);
    if (err.response) {
      return res.status(err.response.status).json(err.response.data);
    }
    next(err);
  }
});

/**
 * DELETE /v1/orgs/:orgId/invites/:inviteId
 * Revoke a pending invite
 */
app.delete('/v1/orgs/:orgId/invites/:inviteId', authenticate, async (req, res, next) => {
  try {
    const { orgId, inviteId } = req.params;

    const coreResp = await coreApi.delete(`/api/team/invites/${inviteId}`, {
      headers: {
        'X-HM-User-Id': req.user.id,
        'X-HM-Org-Id': orgId,
        'Cookie': req.headers.cookie
      }
    });

    res.json(coreResp.data);
  } catch (err) {
    console.error('[Proxy] Error revoking invite:', err.message);
    if (err.response) {
      return res.status(err.response.status).json(err.response.data);
    }
    next(err);
  }
});

/**
 * POST /v1/join/:token
 * Accept an invite token (creates team + project memberships)
 */
app.post('/v1/join/:token', authenticate, async (req, res, next) => {
  try {
    const { token } = req.params;

    const coreResp = await coreApi.post(`/api/team/invites/${token}/accept`, {}, {
      headers: {
        'X-HM-User-Id': req.user.id,
        'Cookie': req.headers.cookie
      }
    });

    res.json(coreResp.data);
  } catch (err) {
    console.error('[Proxy] Error accepting invite:', err.message);
    if (err.response) {
      return res.status(err.response.status).json(err.response.data);
    }
    next(err);
  }
});

/**
 * POST /v1/auth/claim-invites
 * Claim all pending invites for current user's email (first login flow)
 */
app.post('/v1/auth/claim-invites', authenticate, async (req, res, next) => {
  try {
    const coreResp = await coreApi.post('/api/auth/claim-invites', {}, {
      headers: {
        'X-HM-User-Id': req.user.id,
        'Cookie': req.headers.cookie
      }
    });

    res.json(coreResp.data);
  } catch (err) {
    console.error('[Proxy] Error claiming invites:', err.message);
    if (err.response) {
      return res.status(err.response.status).json(err.response.data);
    }
    next(err);
  }
});
```

---

## Environment Variables

Ensure control plane has access to core API:

```bash
# control-plane/.env
CORE_API_BASE_URL=https://hivemind.davinciai.eu
# or for local development:
# CORE_API_BASE_URL=http://localhost:8030
```

---

## Testing the Integration

### 1. Start both services

```bash
# Terminal 1: Core API
cd /opt/HIVEMIND/core
npm start

# Terminal 2: Control Plane
cd /opt/HIVEMIND/control-plane
npm start
```

### 2. Test invite creation

```bash
curl -X POST https://api.hivemind.davinciai.eu:8040/v1/orgs/ORG_UUID/invites \
  -H "Cookie: hm_cp_session=YOUR_SESSION" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "newuser@company.com",
    "roles": ["member"],
    "team_ids": ["TEAM_UUID_1"],
    "project_ids": ["PROJECT_UUID_1", "PROJECT_UUID_2"]
  }'
```

Expected response:
```json
{
  "success": true,
  "invite": {
    "id": "invite-uuid",
    "email": "newuser@company.com",
    "token": "secure-token",
    "teamIds": ["TEAM_UUID_1"],
    "projectIds": ["PROJECT_UUID_1", "PROJECT_UUID_2"]
  }
}
```

### 3. Test invite acceptance

```bash
curl -X POST https://api.hivemind.davinciai.eu:8040/v1/join/INVITE_TOKEN \
  -H "Cookie: hm_cp_session=NEW_USER_SESSION"
```

Expected response:
```json
{
  "success": true,
  "teamsJoined": 1,
  "projectsGranted": 2,
  "orgs": [{
    "orgId": "ORG_UUID",
    "role": "member",
    "teamsJoined": ["TEAM_UUID_1"],
    "projectsGranted": ["PROJECT_UUID_1", "PROJECT_UUID_2"]
  }]
}
```

### 4. Test first-login claim

```bash
curl -X POST https://api.hivemind.davinciai.eu:8040/v1/auth/claim-invites \
  -H "Cookie: hm_cp_session=NEW_USER_SESSION"
```

Expected response:
```json
{
  "claimed": 1,
  "orgs": [{
    "orgId": "ORG_UUID",
    "role": "member",
    "teamsJoined": 1,
    "projectsGranted": 2
  }]
}
```

---

## Authentication Strategy

The control plane proxies must:

1. **Verify session** via `authenticate` middleware
2. **Extract user context** from `req.user`
3. **Forward session cookie** to core API
4. **Pass identity headers**: `X-HM-User-Id`, `X-HM-Org-Id`

Core API will validate session and perform authorization checks.

---

## Error Handling

Proxy routes must:
- Catch `axios` errors
- Forward HTTP status codes from core to frontend
- Log errors for debugging
- Return consistent error format:
  ```json
  { "error": "User-friendly error message" }
  ```

---

## Rollout Plan

### Phase 1: Add Proxy Routes (Day 1)
- [ ] Add invite proxy routes to control plane
- [ ] Add environment variable for core API URL
- [ ] Deploy control plane with new routes

### Phase 2: Test End-to-End (Day 1-2)
- [ ] Test invite creation from AdminUsers page
- [ ] Test invite acceptance flow
- [ ] Test first-login claim
- [ ] Verify team + project memberships created

### Phase 3: Monitor & Iterate (Day 3+)
- [ ] Check control plane logs for proxy errors
- [ ] Monitor core API response times
- [ ] Add retry logic if needed
- [ ] Add rate limiting on invite creation

---

## Alternative: Direct Core API Calls

If modifying control plane is not feasible, update frontend API client:

### File: `frontend/Da-vinci/src/components/hivemind/app/shared/api-client.js`

```javascript
// Change createInvite to call core directly
async createInvite(orgId, payload = {}) {
  // Map frontend format to core API format
  const corePayload = {
    email: payload.email,
    role: payload.roles?.[0] || 'member',
    teamIds: payload.team_ids || [],
    projectIds: payload.project_ids || []
  };

  const { data } = await this.core.post('/api/team/invites', corePayload);
  return data;
}

async acceptInvite(token) {
  const { data } = await this.core.post(`/api/team/invites/${token}/accept`);
  return data;
}

async claimInvites() {
  const { data } = await this.core.post('/api/auth/claim-invites');
  return data;
}
```

**Pros:**
- Simpler (no control plane changes)
- Frontend directly calls core API

**Cons:**
- Breaks control plane abstraction
- Core API must handle CORS for frontend domain
- Session management more complex

---

## Recommendation

**Use Control Plane Proxy** (first approach) because:
1. Maintains separation of concerns
2. Control plane handles auth/session management
3. Core API remains stateless
4. Easier to add rate limiting, logging, caching at proxy layer
5. Frontend doesn't need to know about core API internals

---

## Deployment Checklist

- [ ] Add proxy routes to control plane `server.js`
- [ ] Set `CORE_API_BASE_URL` env var
- [ ] Restart control plane service
- [ ] Test invite creation via frontend
- [ ] Test invite acceptance
- [ ] Monitor logs for errors
- [ ] Update FRONTEND_INTEGRATION_STATUS.md with deployment date

---

**Next Action:** Add proxy routes to control plane and deploy

**Estimated Time:** 1-2 hours (code + test + deploy)

**Risk Level:** Low (isolated changes, easy to rollback)
