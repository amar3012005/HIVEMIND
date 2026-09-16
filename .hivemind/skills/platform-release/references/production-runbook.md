# SINGULANCE production release runbook

## Preflight

Use a clean task worktree from `singulance-main`; fetch the remote and record
the exact SHA. Confirm the target production host and source repository are
the intended pair. Check the active artifact, service health, available disk,
and release manifest before any build. Preserve unrelated work in the server's
checkout: a production build must use a clean detached release directory or
the canonical build helper, never an operator's dirty checkout.

Classify the release before building:

- **Worker/frontend only:** build and deploy only the Worker/frontend from the
  exact merged SHA. Keep runner/Core services untouched.
- **Core/control only:** run its canonical release helper. Run a migration only
  when it is in the committed release and has a tested rollback/recovery plan.
- **Harness runner source, Cordis plugin, or compiled native UI:** build one
  immutable target-architecture runner image from the exact Harness SHA, then
  recreate only `hivemind-harness-runner` through the versioned production
  Compose manifest.
- **Configuration only:** use the service's managed reload/recreate path only
  after proving the current image already contains the required binary/assets.

Do not combine categories because it is convenient. If a frontend and runner
must match, identify both revisions, build both artifacts, deploy each through
its owner, and run a combined canary.

## Harness runner release

1. Start from the pushed Harness SHA. Create a fresh detached build directory
   on a native amd64 production builder (or use the approved builder) and tag
   the image `hivemind/harness-chat:sha-<short-sha>`.
2. Reuse BuildKit/pnpm cache, but expect compilation whenever source or compiled
   native client code changed. Cache reuse never proves an old image contains a
   new bundle.
3. Run `./deploy/hivemind-chat/verify-image.sh <image>` against the image. It
   must resolve the HIVE profile and connected-app plugin. Then run focused
   source tests/typecheck appropriate to the change.
4. Record the currently running runner image as rollback. Deploy the new image
   through a **versioned** production service manifest which contains the
   runner's complete environment, secret references, network, tunnel and
   volume configuration. Do not use a stale generic Compose file that omits
   the runner or hand-write a substitute container definition.
5. Recreate only `hivemind-harness-runner` with `--no-deps`; never use
   `--remove-orphans` during a targeted runner release. Wait for health and
   verify the image revision label.
6. Run the authenticated Harness canary: bootstrap, new session, direct session
   reload, streaming, and the changed plugin/UI behavior. Include a connected
   read or approval/resume path when the release touches connected apps.

## Worker and frontend release

Use the clean source at current `origin/main` or the named release ref. Run the
repository's release assertion/build-contract checks, dependency install, and
guarded Worker deployment command. Static hashed assets may be immutable;
HTML, bootstrap/session endpoints, and WebSocket admission must not be cached
as static content. Verify the actual public origin and the active feature flag
after deploy.

## Failure and rollback

Stop before cutover when source SHA, target identity, secret-managed service
definition, artifact validation, or release helper cannot be verified. A
failed health check or affected canary after cutover means restore the recorded
prior image/Worker version first, then diagnose the first failing boundary.
Do not add emergency patches to an unknown live state.
