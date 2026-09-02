# Visual Intelligence lifecycle

This Worker is an additive, feature-flagged Brand DNA lifecycle. It never
accepts browser traffic and does not replace an existing onboarding or Room
path. Cloudflare Queues/Workflows provide recovery; PostgreSQL remains the
authoritative run and checkpoint store.

## Data boundary

- The trigger carries identifiers and public HTTPS URLs only.
- Core captures rendered public pages with the existing `hm-playwright` safe
  service.
- The Worker immediately stores screenshots in the tenant-qualified R2 key
  `org/{org_id}/runs/{run_id}/screenshots/{n}.jpg`.
- Core receives only R2 references and bounded rendered-page metadata. It reads
  screenshots back through the Worker’s bearer-protected `/artifact` endpoint
  before asking Gemini 2.5 Flash Lite, through Cloudflare AI Gateway, for a
  structured Brand DNA extraction.
- Browser cookies, credentials and screenshot bytes are never stored in
  PostgreSQL, Queue messages, Workflow step output, or Agent Memory.

`user_takeover` is deliberately fail-closed: the trigger must include an
existing `browser_session` name. The safe Playwright service validates that
name against its own approved-session allowlist; the lifecycle never invents,
copies, or accesses a user browser session.

## Required local configuration

Core, not the browser, needs these values in its local-only environment:

```text
VISUAL_INTELLIGENCE_WORKFLOW_ENABLED=true
HIVEMIND_VISUAL_WORKFLOW_SECRET=<shared local Worker/Core secret>
HIVEMIND_VISUAL_ARTIFACT_URL=<local Worker URL>
HIVEMIND_VISION_MODEL=google/gemini-2.5-flash-lite
```

The Worker must receive the same secret as `HIVEMIND_VISUAL_WORKFLOW_SECRET`.
Run local Wrangler state on `P:`:

```powershell
wrangler dev --env local --local --persist-to P:\wrangler\visual-intelligence
```

The local feature gate is fail-closed. It requires all three conditions:

1. `VISUAL_INTELLIGENCE_WORKFLOW_ENABLED=true` in Core.
2. `HIVEMIND_LOCAL_MODE=true` in the local stack.
3. Flagship `visual_intelligence_workflow_v1=true` for the test user and org.

No production resource, Queue, R2 bucket, or flag targeting is used by the
`local` environment. The Worker deployment remains intentionally manual after
the permanent integration worktree has applied the migration and performed the
local browser acceptance run.
