# HIVE Harness chat decisions

Accepted decisions. Do not reopen them in a coding session unless the user
explicitly changes one.

## Accepted

1. **Native Harness, HIVE shell.** Overview mounts native Harness conversation
   runtime. Da-vinci owns navigation. Do not iframe a second Harness frontend.
2. **Full native frontend capacity.** Start from the resolved native `web`
   profile. Add HIVE auth, tenant scope, and tools as a profile patch. Apply
   layout only under `data-dsh-mode="hivemind-chat"`.
3. **Backend freeze.** Do not replace Core, Control Plane, Redis, PostgreSQL,
   tickets, or the runner design while finishing HIVE chat. Fix admission and
   composition against the current authorities.
4. **PostgreSQL is session authority.** Sessions must survive reload and runner
   restart. In-memory Maps are not durable session or approval storage.
5. **Identity is control-plane authority.** Server-derived user/org. Do not
   trust client-supplied tenant identifiers.
6. **Composio is a Cordis plugin, reused.** Port the existing connected-apps
   plugin and composio workflow skill. Do not rebuild Composio from scratch.
   Progressive discovery via Composio meta tools is required; regex tool-name
   gates are not permission authority.
7. **External writes are durable.** connection-required → OAuth → connected
   replay; typed read receipts; editable draft → approval → provider
   completion; cancel/expiry; failure retry without duplicate sends; reload
   while waiting; cross-tenant isolation.
8. **No package-level bind mounts in preview or production.** The runner image
   must contain native web plus `hivemind-web-app` / `hivemind-chat`. Hotfix
   volume mounts of `packages/client/*` are a known failure class.
9. **Do not edit `singulance-main` for this work.** Local integration lives on
   `singulance-local` / the Harness local worktree. Harness source lives on
   `amar3012005/deepseek-harness-hivemind` branch `hivemind-chat`. Promote only
   after `docs/acceptance/HARNESS_CHAT_E2E.md`.
10. **HyperAgents is out of scope** until HIVE chat admission, native
    composition, persistence, and Composio lifecycle are green.

## Rejected

- Replacing Overview with a nested/iframe Harness dashboard.
- Building a custom chat renderer instead of native Markdown/tables/tools.
- Using a public tunnel hostname as the product URL.
- Resetting Core/Control Plane/Postgres/Redis to “simplify” chat.
- Keying Composio discovery as `hivemind:<userId>` without org/workflow
  separation.
- Treating a passing unit suite as proof of an authenticated browser session.

11. **One local Compose entrypoint.** `scripts/harness-chat-env` is the only
    supported command. It uses `infra/docker-compose.hivemind-chat.yml` only.
    `up` rebuilds only the runner with cache; `up-all` is first boot or
    dependency changes; `restart` never builds.

12. **Live production edge is Caddy.** SSH to `singulance` on 2026-09-10 showed
    `hm-caddy` (`caddy:latest`, host network) and no Traefik. Production remains
    untouched. Local preview uses Caddy as `origin-gateway` plus one named
    Cloudflare tunnel in the same Compose project.

13. **One backend generation.** No `hm-*` versus `hivemind-*` duplicates, no
    `hivemind-preview-core-compat`, no extra Compose projects, no package
    bind-mount hotfix graph.

## Open

- Production image registry/digest and the exact Caddy route for a Harness
  runner cutover. Those are promotion-time decisions. They do not change the
  local service contract.
