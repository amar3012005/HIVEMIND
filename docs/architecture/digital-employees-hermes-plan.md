# Digital Employees — Hermes Architecture (Future Reference)

> **Status:** Shelved on 2026-05-11 in favor of **SlackAgents + AgentScope** stack.
> Kept here for future reference if HIVEMIND ever needs a general-purpose
> per-agent Docker pod model (e.g. agents that operate across many surfaces
> beyond Slack: web, voice, email, custom apps).
> The active production plan lives in `docs/architecture/digital-employees-slackagents-plan.md`.

## Summary

Each "Digital Employee" = one Docker container running `nousresearch/hermes-agent:latest` with
- HIVEMIND MCP tools attached (memory recall/save + Slack action wrappers)
- Slack Socket Mode connection (xoxb + xapp)
- Per-employee Postgres-backed config + scoped HIVEMIND API key
- Resource caps (2GB RAM, 1 CPU, 256 pids)
- Network isolation (only outbound to LLM provider + HIVEMIND core)
- Bind-mounted persistent data dir for Hermes session state

## Why we chose Hermes initially

- Battle-tested Nous Research product
- First-class Docker story
- Built-in Slack Socket Mode (no ingress needed)
- MCP client support out-of-box
- Generous tool ecosystem (skills, voice, browser, cron)
- Wraps multiple LLM providers
- 92 doc pages of operational guidance

## Why we paused

After scanning `/Users/amar/HIVE-MIND/references/SlackAgents` (Salesforce
research lib) we found a stack purpose-built for the exact use case:
multi-agent collaboration inside Slack workspaces with workflow graphs.
Hermes is more general — overkill when our day-1 surface is Slack only.

Pair with AgentScope Master-Worker pattern and we get task-level
sub-agent spawning natively. Hermes can only do delegation manually.

## Final architecture (reference only)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Slack Workspace(s)                           │
└───────────────────┬─────────────────────────────────────────────┘
                    │ Socket Mode WS (single ingress)
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  SLACK GATEWAY   (in core process, 2 replicas, leader-elected)  │
│  • Owns ALL xoxb + xapp tokens (one per workspace)              │
│  • Verifies Slack signing secret + envelope                     │
│  • Dedupes (event_id, workspace_id, channel, ts)                │
│  • Normalizes → internal SlackEvent schema                      │
│  • Routes event → correct Digital Employee (by channel/mention) │
│  • Enqueues to Redis: { employeeId, eventType, payload }        │
│  • NO LLM, NO reasoning                                         │
└───────────────────┬─────────────────────────────────────────────┘
                    │ enqueue
                    ▼
       ┌────────────────────────────┐
       │ Redis BullMQ                │
       │ • slack:events  (inbound)   │
       │ • action:intent (outbound)  │
       │ • Retry + DLQ + backoff     │
       └────────────┬────────────────┘
                    │ pull
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  HERMES WORKERS  (Docker containers, 1..N per employee)         │
│  • Stateless. Pull job from queue                               │
│  • Load AgentProfile from HIVEMIND                              │
│  • Use ONLY HIVEMIND MCP tools (22 existing + 4 new slack):     │
│      hivemind_recall, hivemind_save_memory, hivemind_query,     │
│      hivemind_slack_post, hivemind_slack_react,                 │
│      hivemind_slack_search, hivemind_slack_history,             │
│      web_search, web_crawl, code tools, time-travel tools       │
│  • Emit "action intents" back to queue (never call slack.com)   │
│  • Never see Slack tokens                                       │
│  • HPA on queue depth                                           │
└───────────────────┬─────────────────────────────────────────────┘
                    │ MCP RPC + intent enqueue
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  HIVEMIND CORE   (action service + memory)                      │
│  • SlackBridge (P0-1) executes intents:                         │
│      - Policy gate: channel allowlist, user perms, scope        │
│      - Rate-limit per workspace                                 │
│      - Audit row (P0-3): action.slack_post, etc                 │
│      - Auto-ingest result back to HIVEMIND memory               │
│  • Memory engine: recall, save, scope filter (P0-1 access_ctx)  │
│  • MCP server: 22 + 4 tools, per-employee API key (scoped)      │
└─────────────────────────────────────────────────────────────────┘
```

## Schema

```prisma
model DigitalEmployee {
  id                   String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId                String   @map("org_id") @db.Uuid
  teamId               String?  @map("team_id") @db.Uuid
  name                 String   @db.VarChar(100)
  slug                 String   @db.VarChar(120)
  avatarUrl            String?  @map("avatar_url")
  persona              String   // system prompt
  model                String   @default("claude-haiku-4-5") @db.VarChar(100)
  llmProvider          String   @default("anthropic") @map("llm_provider")
  hivemindApiKeyId     String?  @map("hivemind_api_key_id") @db.Uuid
  scope                String   @default("team")
  slackTeamId          String?  @map("slack_team_id")
  slackChannelsAllowed String[] @map("slack_channels_allowed")
  tools                String[] @default([])
  policyRules          Json     @default("{}") @map("policy_rules")
  status               String   @default("draft")
                                // draft|deploying|running|paused|error
  dockerContainerId    String?  @map("docker_container_id")
  k8sReplicas          Int      @default(1)
  hpaMaxReplicas       Int      @default(3)
  metricsLast24h       Json?
  lastActiveAt         DateTime?
  createdBy            String   @db.Uuid
  createdAt            DateTime @default(now())
  updatedAt            DateTime @default(now()) @updatedAt
  archivedAt           DateTime?
}

model SlackEvent {
  id                  String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  slackEventId        String   @unique
  workspaceId         String
  channelId           String?
  ts                  String
  eventType           String
  routedToEmployeeId  String?  @db.Uuid
  payload             Json
  status              String   @default("queued")
  attempts            Int      @default(0)
  createdAt           DateTime @default(now())
}

model ActionIntent {
  id           String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  employeeId   String   @db.Uuid
  actionType   String   // slack_post|slack_react|slack_dm|slack_search
  payload      Json
  status       String   @default("pending")
                        // pending|approved|executed|denied|failed
  denyReason   String?
  approvedById String?  @db.Uuid
  executedAt   DateTime?
  result       Json?
  createdAt    DateTime @default(now())
}
```

## REST API

```
GET    /v1/employees                       org-scoped list
POST   /v1/employees                       create + mint API key + spawn container
GET    /v1/employees/:id                   detail
PATCH  /v1/employees/:id                   edit persona/model/policy
POST   /v1/employees/:id/pause             pause container
POST   /v1/employees/:id/resume
DELETE /v1/employees/:id                   archive + remove container
GET    /v1/employees/:id/metrics           docker stats
GET    /v1/employees/:id/conversations
POST   /v1/employees/:id/rotate-key
GET    /v1/employees/:id/runtime-config    called by container entrypoint
```

## 4 new HIVEMIND MCP tools

| Tool | Body | Wraps |
|---|---|---|
| `hivemind_slack_post` | `{channel, text, thread_ts?}` | `SlackBridge.postMessage` |
| `hivemind_slack_react` | `{channel, ts, emoji}` | reactions.add |
| `hivemind_slack_search` | `{query, count?}` | `SlackBridge.searchMessages` |
| `hivemind_slack_history` | `{channel, since?, limit?}` | `SlackBridge.getChannelHistory` |

All four:
- Require API key with scope `slack:act`
- Resolve workspace via API key → org → DigitalEmployee → slackTeamId
- Persist `ActionIntent` row
- Audit row event `action.slack.*`
- Auto-ingest posted message to HIVEMIND memory scope=team

## Policy engine

```js
async function checkPolicy(intent, employee, redis) {
  const rules = employee.policyRules || {};
  if (rules.allowed_channels && !rules.allowed_channels.includes(intent.payload.channel))
    return { allowed: false, reason: 'channel_not_allowed' };
  const key = `rate:emp:${employee.id}:${Math.floor(Date.now()/60000)}`;
  const count = await redis.incr(key);
  await redis.expire(key, 120);
  if (count > (rules.rate_limit_per_min || 30))
    return { allowed: false, reason: 'rate_limit_exceeded' };
  if (rules.blocked_actions?.includes(intent.actionType))
    return { allowed: false, reason: 'action_blocked' };
  return { allowed: true };
}
```

## Hermes container

```dockerfile
FROM nousresearch/hermes-agent:latest
RUN apt-get update && apt-get install -y curl jq && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh
ENTRYPOINT ["/opt/entrypoint.sh"]
```

`entrypoint.sh`:
1. Read env: EMPLOYEE_ID, HIVEMIND_API_KEY, HIVEMIND_CORE_URL, REDIS_URL, LLM_API_KEY, LLM_MODEL
2. curl HIVEMIND `/v1/employees/$EMPLOYEE_ID/runtime-config`
3. Write `~/.hermes/config.toml` with provider + model + persona + MCP server URL
4. Start Python worker loop:
   - Connect to Redis BullMQ
   - Pull job → extract `text`, `user`, `channel`, `ts`
   - Build prompt: `User in #{channel}: {text}`
   - Call `hermes chat -q "{prompt}"`
   - Hermes uses HIVEMIND MCP tools to reply
   - Mark job complete

## DockerRunner

`core/src/employees/docker-runner.js` using dockerode:

```js
await docker.createContainer({
  Image: 'hivemind/hermes-employee:latest',
  name: `hermes-emp-${employee.slug}`,
  Env: [
    `EMPLOYEE_ID=${employee.id}`,
    `HIVEMIND_API_KEY=${apiKey}`,
    `HIVEMIND_CORE_URL=${process.env.HIVEMIND_CORE_URL}`,
    `REDIS_URL=${process.env.REDIS_URL}`,
    `LLM_API_KEY=${decrypted}`,
    `LLM_MODEL=${employee.model}`,
  ],
  HostConfig: {
    Memory: 2 * 1024 * 1024 * 1024,
    CpuQuota: 100000,
    CpuPeriod: 100000,
    PidsLimit: 256,
    RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 5 },
    NetworkMode: 'hivemind-employees',
    Binds: [`/var/lib/hivemind/employees/${employee.id}:/opt/data`],
  },
});
```

Reconcile loop every 30s: diff DB `digital_employees` vs `docker ps`.

## Safety guardrails

1. Token isolation: Slack tokens NEVER in worker env vars
2. Container resource limits enforced
3. Network mode `hivemind-employees` — outbound only to LLM + HIVEMIND core
4. Concurrency cap per org (default 5 employees, env override)
5. Kill switch: `POST /v1/orgs/:id/employees/pause-all`
6. Audit chain: `slack.event_received` → `agent.job_claimed` → `action.intent_created` → `action.policy_passed/denied` → `slack.post_executed` → `memory.ingested`
7. Spend tracking: `metricsLast24h.tokens` per employee

## Hard prereqs (already shipped)

- P0-1 Teams + Projects + memory scope (for team-scoped employees)
- P0-2 Org-shared connectors (Slack tokens reused via SlackBridge)
- P0-3 Audit log (employee action audit)
- P0-4 RBAC (only org_admin can CRUD employees)

## Soft prereqs

- P1-6 Memory governance (sensitivity for what employees can read)
- P1-9 Outbound webhooks (notify on employee error)
- P1-10 Stripe billing (cost cap on pod minutes + tokens)

## Risks

| Risk | Mitigation |
|---|---|
| Slack rate limits per workspace | Per-workspace concurrency cap in K8s ConfigMap |
| Cost runaway (always-on pods + LLM tokens) | P1-10 billing enforces per-org pod minutes + token quota |
| Persona drift (forgets context) | SlackBridge auto-ingests every msg to memory.scope=team |
| Token security | Sealed-secrets operator + external KMS |
| Docker socket = root-equivalent | Dedicated VPS only; namespace-scoped RBAC if K8s later |
| Pod crash loop wipes session | PVC + Redis backing-store for Hermes session |
| Multi-tenant noisy neighbor | ResourceQuota per Team + LimitRange per pod |

## Build phases (10d for K8s prod, 4.5d for Docker MVP)

| Phase | Effort | Deliverable |
|---|---|---|
| D-1 Schema + REST | 2d | DigitalEmployee table, CRUD endpoints, audit hooks |
| D-2 Hermes container | 1d | Custom Dockerfile + entrypoint.py + HIVEMIND MCP config |
| D-3 K8s controller | 3d | Reconciliation loop, kube SDK, secret management, PVC, HPA |
| D-4 Frontend page | 2d | Grid view, create wizard, metrics panel |
| D-5 Cluster bootstrap | 1d | kind local dev setup + Helm chart for prod K3s |
| D-6 Observability | 1d | Prometheus metrics, Grafana dashboard, alerting |

## When to resurrect this plan

Use Hermes if any of the following becomes true:
- Need to serve agents across many non-Slack surfaces (voice, browser, email)
- Need K8s-native HPA on custom metrics for elastic scaling
- Need ability to embed agents as user-facing CLI tools (Hermes excels at this)
- SlackAgents stack hits limits we can't easily extend

Otherwise: SlackAgents + AgentScope is the simpler, Slack-native path.

## References

- Hermes docs: `/Users/amar/HIVE-MIND/HERMES-DOCS/`
- Hermes manifest: `MANIFEST.json` (92 pages, fetch-page.py for on-demand pulls)
- HIVEMIND memory: `hivemind_recall({ tags: ["plan","p2","digital-employees"] })`
