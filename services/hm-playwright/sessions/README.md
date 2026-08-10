# sessions/ — captured login state, never committed

Layout is **`<org-id>/<platform>.json`** — one subdirectory per org (UUID,
same value used everywhere else in HIVEMIND), holding that org's own
`x.json` / `instagram.json` / `linkedin.json`. Produced by
`../local-login-capture/social-login-capture.mjs`, run on a real machine with
a real login. This directory is gitignored (`.gitignore` here excludes
everything but itself) — a session file is exactly as sensitive as a
password and must never reach a commit.

**Why per-org, not per-platform:** a flat `<platform>.json` was the original
shape and it was a real cross-tenant bug — any org requesting
`session:"linkedin"` would silently ride as whichever org's session happened
to be sitting in that one global slot. Never reintroduce a flat layout here.

`server.mjs`'s `/v1/crawl` requires BOTH `session` (`"x"` / `"instagram"` /
`"linkedin"`) AND `org_id` (UUID) to use a session — `org_id` without a
matching directory, or a session name without a matching file under it, is a
hard `400`/`409`, never a silent fallback to anonymous or to another org's
session. The production Compose file mounts this whole directory read-only
at `/app/sessions`.

Read-only reuse only. This must never grow into click/post/follow automation.
