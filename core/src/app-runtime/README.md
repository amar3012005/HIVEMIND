# App Runtime infrastructure (opt-in)

AppSpec v1 defines data and approved view metadata. It does not execute generated code, modify
Prisma per customer, register an agent profile, or activate an existing runtime composition.
The API and Cordis package require explicit integration; this directory is infrastructure first.

The opt-in server integration now uses `postgres-runtime.js` and `postgres-transaction.js` for
direct `pg` access. Its pool is capped at five connections; `HIVE_APP_RUNTIME_DATABASE_URL`
can supply a non-superuser/non-BYPASSRLS credential for the same platform database. Every
transaction checks the database role before scoped application queries. Prisma remains in
platform identity, but is not in the mounted CRM storage path. The old Prisma adapter is retained
only for compatibility demonstrations. See `docs/CRM_INTEGRATION_DEMO.md` for activation details.

The CRM credential cannot update platform identity. The migration-owned
`app_runtime_lock_membership(uuid,uuid)` function holds membership/user/organization row locks
until the CRM transaction ends, returning only roles and active status. Its SQL names every
table explicitly, locks `search_path` to `pg_catalog`, checks transaction-local identity, and
revokes public execution. `core/scripts/provision-app-runtime-role.mjs` grants only CRM data
access, this function, and selected workflow receipt columns. Run it through the managed
migration job with secret references; never reuse the platform superuser credential.

## Optional API boundary

`createAppRuntimeHandler({pool, resolvePrincipal})` supplies an unmounted HTTP handler under
`/api/app-runtime/apps`; it reuses an existing PostgreSQL pool. Integration must authenticate and
enforce token scopes/audience before resolving the principal. Database membership is checked on
every operation. Organization owners/admins manage definitions and publishing; members/team leads
write records; viewers/compliance admins can read. Guests and service accounts are denied in v1.

Versions, audit entries and idempotency receipts are append-only through this API. There is no
delete endpoint. Metadata lists are bounded and omit full specs; record queries are cursor-paged
and bounded to a 512-KiB response data budget. Use app-get to retrieve definitions.

## Contract

`contract.js` exports:

- `validateAppSpec(input)` returns a copied, canonical definition or `AppRuntimeError`.
- `validateRecordData(spec, entityId, data, { partial = false })` returns typed copied record data.
- `applyAppSpecPatch(spec, patch)` replaces selected top-level metadata/arrays and validates the
  complete result. It does not persist or increment versions.
- `APP_SPEC_JSON_SCHEMA` describes the wire shape for general JSON Schema clients.
- `APP_SPEC_TOOL_SCHEMA` uses the native DSH supported schema subset with conditional `oneOf`
  branches. Semantic bounds and references still require the Core validator.
- `APP_RUNTIME_LIMITS` and `EXAMPLE_CRM_SPEC` describe budgets and a companies/contacts/deals draft.

The metadata shape is:

```json
{
  "schemaVersion": 1,
  "name": "Sales workspace",
  "entities": [{
    "id": "deal", "name": "Deals",
    "fields": [
      { "id": "name", "name": "Name", "type": "text", "required": true },
      { "id": "stage", "name": "Stage", "type": "enum", "options": ["Review", "Won"] }
    ]
  }],
  "relations": [],
  "views": [{ "id": "pipeline", "name": "Pipeline", "type": "kanban", "entityId": "deal", "groupByFieldId": "stage" }]
}
```

Entity, field, relation and view IDs are stable lowercase identifiers, independent of display
names. Views and reference fields must resolve within the same spec. Unknown properties, accessors,
non-JSON values, prototype-sensitive keys, duplicate IDs and oversized/deep payloads are rejected.
Canonicalization supplies `required: false`, `source: {type: "local"}`, empty relations, and omitted
view field lists. Enum options and human-readable labels are trimmed.

## Records and relations

Record keys are field IDs. Supported types are text, finite number, boolean, enum, reference, and
calendar-valid `YYYY-MM-DD` date. Optional values can be omitted or null. Required text cannot be
empty/whitespace; required values cannot be null. Partial updates validate provided values only;
the service must merge with stored data and validate the complete record before persistence.

References are UUID record-ID strings. Shape validation is **not referential integrity**: the
service must resolve every supplied reference to a live record of the declared target entity in
the same organization and app. Explicit relation instances similarly require target checks,
cardinality enforcement and transactional updates. In this infrastructure slice, `relations` are
descriptive metadata only; persisted links are singular reference fields, not a complete relation
instance/cardinality engine. Never trust tenant IDs in AppSpec or model input.

External field metadata requires `source: {type: "external", provider, object, property}`. This is
mapping metadata, **not connector authorization**. Existing connector ownership and write approvals
must be enforced by the integration. Local record tools deny writes to external/derived fields;
required nonlocal fields therefore need a future governed integration before records can be created.
Derived fields are labeled `source: {type: "derived"}`; actual
evidence links and write provenance belong in durable service records, not claimed by this label.

## Versioning and future integration

`schemaVersion` is the contract dialect. An application's optimistic revision belongs to storage:
create a new immutable definition version with an expected-version check. Keep published pointers
separate from drafts. Existing records must be checked before a new version becomes active.
Removing a populated field, adding a required field, changing types/options, or retargeting a
reference needs an explicit compatible transition/backfill; do not silently delete data.

This slice does not implement workflow execution, connector sync, arbitrary formulas, custom
components, backfills, row-level field permissions, or a frontend renderer. Use existing native
Cordis tools/skills and permission hooks when integrating. No agent loop changes are needed.

Native docs consulted: `subsystems/tools.md` (canonical output validation) and
`subsystems/skills.md` (scoped progressive providers), revision
`639ed015397290b3745d163aafe02ffee4aa3f84`. The generic AppSpec metadata is not a replacement for
native skill loading, tool dispatch, context lifecycle, or scheduler durability.
