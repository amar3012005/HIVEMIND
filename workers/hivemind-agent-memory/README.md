# HIVEMIND Cloudflare Agent Memory

One durable, project-wide engineering-memory ledger shared by every HIVEMIND
worktree. The Worker exposes an authenticated MCP endpoint while a single
Cloudflare Agents SDK instance named `hivemind` owns the SQLite database.

Git remains authoritative for code, commits, release history, and decision
documents. Agent Memory is the searchable cross-session index and durable
handoff layer for decisions, architecture gaps, patch work, incidents,
requirements, releases, gotchas, and important project context.

## Memory discipline

At task start call `memory_health`, then `memory_search` for the task, component,
and affected files. Use `memory_recent` when resuming without a precise query.

After verified work call `memory_remember` with category, evidence-backed
content, tags, Git branch/worktree/commit provenance, references, and a stable
dedupe key. Use `supersedes_id` and `memory_set_status` rather than deleting
audit history.

Never store credentials, access tokens, customer report bodies, personal data,
or unverified claims. Do not describe uncommitted work as completed.

## Local development

Create an ignored `.dev.vars` containing:

```text
HIVEMIND_AGENT_MEMORY_TOKEN=<local-only-token>
```

Run `npm install`, `npm run types`, `npm run check`,
`npx wrangler deploy --dry-run`, and `npm run dev`.

## Deployment

Set the production Worker secret `HIVEMIND_AGENT_MEMORY_TOKEN` through Wrangler
without committing or logging its value, then deploy with `npx wrangler deploy`.
Clients connect to `/mcp` and read the bearer token from the same user-level
environment variable. `/health` exposes only schema version and aggregate
counts; all MCP tools require authentication.
