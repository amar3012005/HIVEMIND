# sessions/ — captured login state, never committed

Each `<platform>.json` here is a Playwright `storageState` dump (cookies +
localStorage) for one platform — `x.json`, `instagram.json`, `linkedin.json`.
Produced by `../local-login-capture/social-login-capture.mjs`, run on a real
machine with a real login. This directory is gitignored (`.gitignore` here
excludes everything but itself) — a session file is exactly as sensitive as a
password and must never reach a commit.

`server.mjs`'s `/v1/crawl` accepts an optional `session` field (`"x"` /
`"instagram"` / `"linkedin"`) matching a filename here (sans `.json`). The
production Compose file mounts this directory read-only at `/app/sessions`.
If a requested session is missing, the API returns `409 session_not_found`
instead of silently issuing an anonymous crawl.

Read-only reuse only. This must never grow into click/post/follow automation.
