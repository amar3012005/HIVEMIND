# Harness runner least-privilege staging

The production runner currently uses a superuser/BYPASSRLS database role. Native predicates still restrict tenant queries, but RLS cannot protect that effective role. The isolated proof does not establish production RLS enforcement.

## Staging artifact

`scripts/security/provision-harness-runner-role.sql` is an idempotent, transactional operator staging script. It creates `hivemind_harness_runner` **NOLOGIN**, without superuser, BYPASSRLS, database creation, role creation or replication. It refuses an existing privileged role. It grants explicit native table operations and the event identity sequence; there are no blanket schema grants, memory writes, table ownership changes or credentials in the file.

Run only through the managed database provisioning path after review. The SQL does not activate a login, change runner configuration, or replace the shared Core role. A separate managed secret must configure the dedicated role's password/login and runner connection string. Preserve the old runner configuration for rollback. Never copy the shared role's password into this new role.

Before activation, verify role memberships and pre-existing grants/default PUBLIC grants do not add privileges beyond this manifest. The script adds required grants; it intentionally does not silently revoke unknown existing grants or change another service's role.

## Isolated verification

A disposable PostgreSQL 16 fixture passed **28 checks** under NOSUPERUSER/NOBYPASSRLS. It uses canonical Core session/Dreamer/connector migrations, native Schedule/HQ migrations and actual built native PostgresSessionPersistence, BrowserAuth and DreamStore. The exact staging script ran twice; its new NOLOGIN role admitted scoped native reads and denied memory updates.

Verified paths include session/event/lease isolation, cookie RPC admission revocation, trusted Schedule due metadata without task content, HQ reads/inserts without deletion, Dreamer accept/claim/heartbeat/checkpoint, reserved project/membership creation, memory read/traversal filtering, billing aggregation, connector consent revocation and output receipt idempotency.

Connector records are dummy provider data. The memory-save boundary is a fake Core adapter that supplies a dummy saved destination/receipt; no external provider or live company memory was used. This validates runner SQL compatibility and boundary handling, not an end-to-end external connector or live memory-provider write.

The fixture's minimal authority-table schema is source-derived. A second bounded fixture reconstructed the current schema from read-only metadata only: 23 tables including the teams dependency, 292 columns, actual enum values/defaults/constraints/standalone unique indexes and native RLS policies. Seven native DreamStore checks passed against that shape under the exact staged role: reserved project/membership creation, acceptance/claim/heartbeat, memory read/recent/traversal filtering, billing sum, connector evidence/revocation, output receipt idempotency, and inactive-member denial. Only dummy rows were inserted; no tenant data was exported. This is a target-table schema clone, not a full application schema/trigger reproduction. Managed dedicated secret/login and runner configuration activation are still required; no role activation was performed. No production roles, credentials, table grants or service configuration changed during this proof.

## Scope compatibility

Live native policies use `app.hivemind_org_id` and `app.hivemind_user_id`. Requested authority tables exist in `hivemind`, with RLS disabled. There is no live `app.current_*` policy requiring an alias correction. Schedule's trusted metadata index permits its scheduler flag. Dreamer's trusted due index contains identities/lease flags only; content queries run under owner scope and active membership validation.

Security readiness is not signed off by this staging artifact.

## Startup and migration boundary

The current-schema fixture additionally ran the actual native SessionPersistence, PostgreSQL Schedule and HQ ownership `Service.init` methods under the staged restricted role. Initialization passed without CREATE, ALTER or ownership privileges; the HQ service registration port was a fixture stub. DreamStore construction and native operations also passed. Dreamer plugin source creates its pool and native background operations without startup DDL. The runner deployment README assigns canonical migrations to Core and validates existing tables at startup.

Future schema migrations must keep the existing operator/migration identity separate from the restricted runtime connection. Do not grant DDL or ownership to make runtime startup pass, and do not run canonical migrations with the restricted runtime URL. Missing or incompatible migrations should fail startup clearly rather than silently widen grants. This check covers provider initialization, not a full production process boot or external providers.

## Managed runner-only connection override and cutover

Canonical Compose now accepts optional `HIVE_HARNESS_DATABASE_URL` for **harness-runner only**, falling back to the existing shared connection expression when unset. The existing protected production `ENVF` remains the sole secret configuration path. Docker Compose rendering with a dummy-only environment verified both fallback and dedicated override; only harness-runner's configuration changed. Core, Postgres and sibling services retain their settings.

Reviewed operator sequence (root release owner executes):

1. Preserve the current protected ENVF with its existing ownership/mode in the existing protected release/config backup location; never print its contents or place it in a source/build worktree. Record the current runner image reference and immutable source manifest.
2. Apply the staging SQL using the existing migration/operator database identity. Verify dedicated role flags, absence of inherited privileged memberships, and its explicit grants against this manifest. Keep shared Core/Postgres role unchanged.
3. Generate a **new dedicated credential** with the existing managed secret mechanism. Set its password and enable LOGIN privately through the operator boundary, with no command-line password, logs, Git files, or reuse of POSTGRES_PASSWORD. Add only `HIVE_HARNESS_DATABASE_URL` to protected ENVF using the established private configuration update path. This artifact deliberately supplies no credential value.
4. Promote this reviewed Compose change to canonical source. Use its exact immutable `release-canonical.sh` with `--services harness-runner --service-scoped --skip-migrations`, the verified pinned current runner image/artifact options, and the normal canary. Retain release presence, host lock and compatibility gates; native idle status checks are observations, not an admission gate. Do not bypass the service-scoped compatibility review for an infra change.
5. Verify healthy runner, its effective database role flags, native session creation/read/write, scheduled discovery/dispatch, HQ lookup and Dreamer startup. Collect metadata/receipts without tenant data or credentials. Check that Core/Control/siblings were not restarted or reconfigured.
6. If verification fails, restore the protected ENVF snapshot and release only harness-runner with the previously verified image/config through the same drained helper. Leave the new dedicated role unselected; disable its LOGIN after confirming no remaining connection uses it. Do not roll back shared Core credentials or database data.

The exact canonical helper supports a runner-only cutover and consumes protected ENVF. It does not provision credentials. The remaining execution prerequisite is root/operator managed credential creation and private ENVF update; no parallel secret store or unrestricted runtime migration privilege is needed. This plan and SQL remain unapplied to production.

## Operator helper correction

The canonical runner release helper restarts the companion tunnel and its older drain contract was absent from the former runner. Do not describe that older helper as a strict sibling-preserving graceful drain. The current image now exposes authenticated native active-count observations; two idle observations reduce interruption risk but do not stop new turn admission.

`runner-role-cutover.py` is a reviewed-source derivative of the existing HQ cutover path. It preserves the complete live Compose chain and current image, appends one versioned runner-only DATABASE_URL override, compares the entire rendered config allowing only that delta, and checks sibling container identities. Dry mode performs no role/ENVF/container mutations. Execute mode provisions a fresh credential through native pg with private stdin, saves an owner-only managed ENVF backup, updates only its dedicated URL, performs runner-only recreation, and validates health/effective restricted role. Failure restores the original ENVF and original complete chain and disables the newly provisioned login. The helper must be reviewed before execution; idle checks are explicitly observations rather than an admission gate.

The current role-only helper supersedes the earlier canonical-recreation sequence for this cutover so the tunnel and siblings remain untouched. Use distinct release names for dry review and execution. It verifies the authenticated native recovery-status endpoint after healthy startup, as well as effective restricted role flags/memberships and expected native table access. Ambiguous provisioning failure reconciles whether the dedicated role is absent or committed before revoking LOGIN; failed reconciliation is reported as unconfirmed rather than claiming revocation.
