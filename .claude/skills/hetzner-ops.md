# SINGULANCE Host Operations

Production is `ssh singulance`. Use `.claude/scripts/hm` for read-only status,
logs, release identity, and health. For any mutation, follow
`docs/PRODUCTION_RELEASE_PROTOCOL.md` and `SINGULANCE-ONBOARD/OPERATIONS.md`,
stopping if those authorities conflict.

Never operate on `myserver`, print `.env`, prune data volumes, restart data
services for an app release, or delete images before proving live and rollback
digests. PostgreSQL/Qdrant backups require freshness and restore evidence.
