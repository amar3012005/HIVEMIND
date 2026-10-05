# Consolidate the runner's native Compose configuration

`consolidate-runner-compose.py` is a narrow operator wrapper around the existing Docker Compose release path. It does not create a release registry, scheduler, secret store or recovery loop. Root reviews and executes it with the exact currently deployed runner image and a unique release name.

## Review and execution

Dry mode reads the complete configuration chain from the runner's existing Compose labels and the protected managed `/root/hivemind/.env`. It merges **all profiles** without interpolation, environment-file expansion or premature path resolution. Static relative paths become absolute under the original project-directory; variable-bearing paths retain that explicit original anchor. The versioned managed JSON keeps `${...}` references and rejects unmanaged literal credential fields/URLs.

The helper re-renders the managed file and requires exact raw equivalence across all profiles, then exact normalized resolved configuration equivalence for the existing Harness profile. It validates current image/environment and two authenticated native idle observations. Those observations are not a new admission gate. Dry mode writes only protected review/config artifacts, never changes ENVF, roles or containers. Use a different release name for execution.

Execution takes the native release lock, preserves the original chain files and an owner-only managed ENVF rollback snapshot, and re-creates **only harness-runner** with the same image and configuration so its Compose labels now reference one managed file. `--no-deps` avoids tunnel and sibling restarts. It validates healthy startup, unchanged image/environment/mounts/networks/ingress, sibling identities and authenticated native recovery status. On failure after recreation, the original full chain is used to restore runner configuration; ENVF was never changed. Original files remain available.

No tenant data or resolved credentials belong in the new managed Compose file or public manifest. ENVF backup stays protected under the existing release-config snapshot path; it is not another active secret store.

## Verification

Seven mocked tests cover dry equivalence, retained interpolation without materialized credentials, rejection of literal secrets/configuration drift, active-work deferral, health rollback to the original chain, and sibling preservation. A real Docker Compose roundtrip with dummy environment only verified raw and resolved equivalence across 16 services. Production execution is separate and remains root-owned.

## Future releases

The canonical release helper already creates a bounded base-plus-image override from immutable source; that path should remain authoritative. Ad hoc native image/config cutovers must start from the latest managed file and reconcile their reviewed delta into a **new versioned managed file**, validate it against the previous effective configuration, and switch to that file. They should not keep appending historical override paths. When canonical source changes, review the specific source delta against the managed baseline before generating its replacement; preserve dedicated runner database, current provider settings and unrelated newer configuration.

This consolidation changes only configuration provenance/labels, not the application's behavior or privileges. It does not claim broader production readiness.
