# SCIM 2.0 Provisioning — Status

**Status**: MVP shipped (alpha — untested against real Okta/Azure sandbox).
Bearer auth + Users + Groups CRUD live on the control plane.
See `core/src/scim/scim-routes.js`.

What's deferred:
 - Okta/Azure sandbox integration testing
 - Complex PATCH path expressions (e.g. `emails[type eq "work"].value`)
 - Bulk endpoint (RFC 7644 §3.7)
 - Enterprise extensions (manager, department)
 - SCIM filter ops beyond `eq` (`co`, `sw`, `pr`, `gt`, etc.)

## What works today

- `/v1/orgs/:id/sso` GET/PUT — store SSO config (Zitadel OIDC, SAML, subdomain)
- `/v1/orgs/:id/sso/scim-token` POST/DELETE — generate/revoke a SCIM bearer
- `OrgSsoConfig.scimTokenHash` — bcrypt-hashed bearer for verification
- JIT provisioning flag on SSO config — user auto-created on first SSO login

## What's missing (the actual SCIM server)

RFC 7644 endpoints, all under `/scim/v2/` on the control plane,
authenticated by `Bearer <scim_token>` matched against `OrgSsoConfig.scimTokenHash`:

| Endpoint | Method | Behavior |
|---|---|---|
| `/scim/v2/ServiceProviderConfig` | GET | static JSON: supported ops, auth schemes |
| `/scim/v2/Schemas` | GET | static User + Group schema |
| `/scim/v2/ResourceTypes` | GET | static |
| `/scim/v2/Users` | GET | filter by `userName eq "x@y"`; paginate via `startIndex` |
| `/scim/v2/Users` | POST | create User row + UserOrganization upsert |
| `/scim/v2/Users/:id` | GET | single user |
| `/scim/v2/Users/:id` | PUT | replace (full update) |
| `/scim/v2/Users/:id` | PATCH | partial (RFC 7644 §3.5.2) |
| `/scim/v2/Users/:id` | DELETE | soft-delete (deactivate UserOrganization) |
| `/scim/v2/Groups` | GET | map to Teams |
| `/scim/v2/Groups` | POST | create Team |
| `/scim/v2/Groups/:id` | PATCH | add/remove TeamMember |

## Tradeoffs to decide before implementation

1. **Group → Team or Group → Project?** SCIM Groups map cleanest to
   HIVEMIND Teams. Projects need different invitation semantics.
2. **Soft-delete vs hard-delete on DELETE Users.** SCIM spec allows
   either; recommend soft (UserOrganization.is_active=false) to preserve
   memory authorship.
3. **Multi-org users**: SCIM endpoint scoped per-org (bearer determines
   org). One user with multiple SSO providers → multiple SCIM bearers.
4. **Rate limiting**: Okta/Azure bursts ~50 RPS on initial sync.
   Per-org bucket needs to be raised or whitelisted.

## Test plan

- Mock SCIM server in `tests/scim/` driving real CRUD
- Okta sandbox tenant for end-to-end verification
- Edge cases: paginate >1000 users, group membership re-sync, deletion
  cascade against active sessions

## Stub endpoint

Until full SCIM lands, GET `/scim/v2/ServiceProviderConfig` returns a
documented "not yet implemented" payload so IdP discovery doesn't 404.

```
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  "implementation_status": "stub",
  "implementation_eta_days": 5,
  "contact": "amar@davinciai.eu"
}
```

## Owner & estimate

Single eng-week with Okta sandbox available. Add 1-2 days for Azure AD
quirks (resource counts at root URL).
