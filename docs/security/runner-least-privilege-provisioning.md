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
