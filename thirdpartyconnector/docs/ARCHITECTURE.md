# High-Level OAuth Connect Schema

## Components

- Partner Frontend: renders `Connect with HiveMind` button.
- Partner Backend: generates PKCE+state, handles callback, stores encrypted tokens.
- HiveMind OAuth Authorization Server:
  - `/oauth/authorize`
  - `/oauth/token`
  - `/oauth/revoke`
  - `/.well-known/oauth-authorization-server`
- HiveMind Protected Resource:
  - `/.well-known/oauth-protected-resource`
  - API + MCP runtime with bearer validation + scope checks.

## Data Model (server-side)

### OAuth Client Registration

```json
{
  "client_id": "string",
  "client_name": "string",
  "redirect_uris": ["https://partner.example.com/callback"],
  "allowed_scopes": [
    "memory.read",
    "memory.write",
    "tools.invoke",
    "workspace.connect",
    "mcp.connect"
  ],
  "is_public": true,
  "status": "active"
}
```

### Token Claims Shape

```json
{
  "iss": "https://core.hivemind.example",
  "aud": "https://core.hivemind.example",
  "exp": 1735689600,
  "sub": "user-id",
  "org_id": "org-id",
  "workspace_id": "workspace-id-or-null",
  "scope": "memory.read memory.write"
}
```

## Trust Boundaries

- Browser never receives refresh token storage responsibility.
- Partner backend stores tokens encrypted at rest.
- HiveMind validates redirect URI + PKCE + scopes on every grant flow.
- API and MCP endpoints challenge unauthorized clients with `WWW-Authenticate` metadata hints.
