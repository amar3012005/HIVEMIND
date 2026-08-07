# sessions/ — captured login state, never committed

Each `<platform>.json` here is a Playwright `storageState` dump (cookies +
localStorage) for one platform — `x.json`, `instagram.json`, `linkedin.json`.
Produced by `../local-login-capture/social-login-capture.mjs`, run on a real
machine with a real login. This directory is gitignored (`.gitignore` here
excludes everything but itself) — a session file is exactly as sensitive as a
password and must never reach a commit.

`server.mjs`'s `/v1/crawl` accepts an optional `session` field (`"x"` /
`"instagram"` / `"linkedin"`) matching a filename here (sans `.json`). If the
name doesn't resolve to a real file, the request silently falls back to an
anonymous (logged-out) context rather than failing — a stale/expired session
should degrade gracefully, not 500.

Read-only reuse only. This must never grow into click/post/follow automation.
