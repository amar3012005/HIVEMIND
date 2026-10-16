# Delivery contract

## Pick exactly one change class

| Change | Owner artifact | Required workflow |
| --- | --- | --- |
| Browser shell, routing, static UI | Da-vinci Worker/frontend | build and deploy Worker only |
| Cordis plugin, profile, or compiled native UI | Harness runner | targeted local/Enigma refresh; immutable runner image for production |
| Memory/identity/API/schema | HIVE-MIND Core | migration-aware Core release only |
| Playbook/runtime behavior | HyperAgents runtime | runtime-specific release plus lifecycle canary |
| Voice provider or UX | Tara runtime | adapter/runtime canary |

Never rebuild a database, Core, Worker, runner, or voice service when it is not
the owning artifact.

## Environment contract

1. **Local (`singulance-local`):** reproduce and validate the smallest change.
   For development-mounted Harness changes, use the repository's managed
   runner-refresh command. It preserves runtime secrets and recreates only the
   runner.
2. **Enigma (`enigma-main`):** promote a verified preview artifact. Validate the
   authenticated browser path and the changed service boundary.
3. **Production (`singulance-main`):** release from a clean canonical branch.
   Record prior artifact identities, build immutable artifact(s), run migration
   gates if required, deploy behind the relevant feature flag, execute
   authenticated canaries, then write a release lock.

## Feature flags

The HIVE chat flag is binary:

- `harness` → native Cordis/Harness.
- `legacy`, absent, or unrecognized → LangGraph/LangChain.

No client should load native Harness assets for a legacy admission. A direct
native URL for a legacy admission must return to the legacy overview route.

## Canary minimums

Every release proves only the relevant rows, plus authenticated login:

- Worker: authenticated route, static assets, cache policy, and legacy/native
  admission routing.
- Runner: resolved profile, plugin bootstrap, fresh session, direct session URL
  reload, stream, and changed native UI/tool behavior.
- Core: migration state, health, authorization deny-path, changed API path, and
  durable persistence/replay where applicable.
- Connected work: connection-resume, one selected operation, bounded evidence,
  rejection and approval of a controlled write.

## Release record

A release lock includes:

```text
environment, source commits, immutable image digests, Worker version,
configuration revision, migrations, feature flag cohort, canary receipts,
previous artifact identities, rollback command
```

The rollback is the prior Worker version and/or prior immutable artifact. Never
roll back a database by guessing.
