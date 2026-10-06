# Native employee lifecycle server recovery

## Source provenance
Recovered `core/src/employees/native-lifecycle.js` from the server's existing isolated security proof source, rather than assuming unpublished Mac commits migrated. Core base is canonical bf73ef56. Native base is cb14eb1b. No production change.

## Implemented here
- One Core registry authority for active administrator human requests and verified native Chief requests.
- Durable and future-deadline temporary employees, idempotent serialized creation, no credentials/connectors minted.
- Existing DigitalEmployee row remains draft so it is excluded from running/deploying sidecar reconciliation.
- Current-revision archive proof reads native task acceptance, outstanding delegation and recorded private closeout memory, retaining session/task history.
- Legacy bootstrap, slug chat profile, remint and per-ID mutation paths exclude native rows; legacy creation cannot inject reserved metadata.
- Native assignment delivery rechecks current registry on scheduled delivery and pre-step.
- Native cached owners reauthorize against current registry; closeout confines available tools and messages to safe private closeout/reporting.
- Chief tool uses existing defineTool, signed service transport, capability allowlist and native Schedule closeout wake for temporary creation.

## Verification completed
- Core module/routes/server syntax.
- Three focused lifecycle tests plus a signed route test verifying general chat and revoked membership rejection before request-body parsing.
- Existing disposable actual PostgreSQL/native persistence proof: ten checks including two organizations, concurrent creation replay, actual task/review/memory closeout and retained session history.
- Final Runtime and HQ package compilations passed in a read-only disposable cb14 container, including deadline/closing changes.

## Required before release
- Human creation UI and native temporary deadline activation from human creation.
- Schedule cleanup after archive across all authorized persistent rooms. Delivery is denied, but old active schedule rows require explicit cleanup.
- Native tool-level authorization including tools installed after closeout masks; investigate live schema and direct cached tool references before claiming full confinement.
- Full native persistent Teams creation/review/recurring Schedule E2E in two dummy organizations.
- Focused route authentication, legacy remint exclusion and actual client tests.
- Compile final additions and normal repository guard/lockfile reconciliation.

Not a completed lifecycle release and no readiness signoff.
