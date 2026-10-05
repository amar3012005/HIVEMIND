# CRM infrastructure: integration boundary

This change prepares a shared, metadata-driven application runtime for CRM workspaces.
It does not activate a new agent persona, profile, command, route, schedule, or deployed service.

## Ownership

- Core owns authenticated application definitions, versions, records, relations and audit receipts.
- The optional Harness App Builder package uses native Cordis tools to access that API.
- Existing Runtime and HyperAgents decide when to build or delegate work.
- Da Vinci will render the published AppSpec using a restricted component library.
- Existing connected-app and approval infrastructure will own external operations.

## V1 scope

AppSpec describes entities, typed fields, explicit relations and table/Kanban/record views.
The database stores stable relational identity and dynamic record attributes in JSONB.
Draft changes use expected versions; publication produces an immutable definition.
Ordinary metadata customization does not modify Prisma or execute generated code.
Business automations, external synchronization and destructive schema migrations are not enabled by V1.

## Later integration sequence

1. Review and apply the platform migration in an isolated preview database.
2. Mount the exported Core handler behind the existing authenticated tenant authority.
3. Explicitly allow the new service routes in the current signed Harness service gateway.
4. Build and mount the optional App Builder plugin in the existing HyperAgents composition.
5. Register a CRM-building instruction skill through the existing progressive skill mechanism.
6. Add Your CRM beneath Artifacts and render published definitions in Da Vinci.
7. Resolve `@create CRM` through the existing supported invocation mechanism; preserve the user's
   raw request and current session rather than constructing a second agent runtime.
8. Exercise draft, preview, publication and record changes across two organizations before release.
9. Add one real connector trigger and governed action only after verifying its current contracts.

## Runtime invariants

- Tenant and actor identity come from authenticated claims, never model arguments.
- Every relation and reference must resolve within the same organization and application.
- Retry identities are bound to the actor, operation and request content.
- Publication and edits require optimistic concurrency and current membership authorization.
- Preview is structured data; neither JavaScript nor arbitrary SQL is accepted from AppSpec.
- A published field's destructive evolution requires an explicit migration policy, not silent removal.
- Current Core/Harness composition and agent-loop behavior remain untouched by this preparation.

## Verification boundary

Static syntax and package compilation are suitable preparation checks. They do not prove database
migration compatibility, row-level security with production roles, authenticated routing, or end-to-end
CRM behavior. Those checks belong to the later integration and preview release.

## Implemented entry points

- `core/src/app-runtime/contract.js`: AppSpec and record validators, general/native JSON schemas,
  metadata patch helper and an example companies/contacts/deals spec.
- `core/src/app-runtime/store.js`: injected-pool transactional storage and tenant authorization.
- `core/src/app-runtime/routes.js`: `createAppRuntimeHandler({pool, resolvePrincipal, parseBody?,
  jsonResponse?})`, returning an optional `async ({req,res,pathname}) => boolean` handler.
- `core/prisma/migrations/20261005100000_app_runtime_infrastructure/migration.sql`: unapplied
  platform tables, composite tenant keys, RLS and append-only history triggers.
- Harness sibling worktree `deepseek-harness-crm-infrastructure/packages/hivemind/app-builder`:
  optional native Cordis package; no bundle or preset registration.

The API prefix is `/api/app-runtime/apps`. Schema mutation is owner/admin only. Active members
and team leads can change published records; viewers and compliance admins can read. Guests and
service accounts are rejected by this initial policy. The embedding principal resolver must verify
token audience, scopes and authority before returning `orgId` and `userId`.

Mutations require stable `operationId`; edits/publication require `expectedVersion`. Metadata-only
app listing is capped; published records use UUID cursors and a 512-KiB response budget. Do not retry
an ambiguous write with a new operation ID.

V1 operational links are singular reference-field edges. AppSpec relation cardinality is descriptive
metadata until a later relation-instance API enforces it. External/derived field writes are blocked;
connectors and provenance must be wired through existing governed capabilities. History is append-only,
and V1 has no application deletion or retention lifecycle. Existing-record schema backfills, frontend
rendering, `@create CRM` invocation, skill activation and workflow execution are future integration work.

## Completed preparation checks

All three Core JavaScript modules passed `node --check`; both worktrees passed `git diff --check`.
The optional plugin passed a focused strict TypeScript no-emit compilation using the existing Harness
peer declarations. These are static checks, not live API or database verification. No tests were added
or run, no migration was applied, and no package was mounted or deployed. Prisma schema validation
still requires a Prisma CLI; the existing checkouts did not provide one during preparation.
