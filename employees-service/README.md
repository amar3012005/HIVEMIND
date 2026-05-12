# HIVEMIND Digital Employees Service

Python sidecar that hosts autonomous AI agents ("Digital Employees") with
Slack workspace presence, HIVEMIND memory access, and AgentScope Master-Worker
task delegation.

Runs as a separate container (`hm-employees`) alongside `hm-core` and
`hm-control-plane`. Deployed via Coolify on the production VPS — NOT a local
dev tool.

## Layout

```
employees-service/
├── NOTICE                # Apache 2.0 attribution to Salesforce
├── pyproject.toml        # poetry — wraps slackagents + adds FastAPI etc
├── Dockerfile            # python:3.12-slim base, vendored install
├── vendor/
│   └── slackagents/      # vendored from SalesforceAIResearch/slackagents (Apache 2.0)
└── src/
    └── hivemind_employees/
        ├── main.py       # FastAPI service entry, /health + /admin/reload
        ├── config.py     # env + per-employee runtime config
        ├── db.py         # asyncpg pool to shared Postgres
        ├── redis_client.py
        ├── hivemind_client.py   # HTTP/MCP client to HIVEMIND core
        ├── slack/
        │   ├── gateway.py       # Bolt app per workspace, multi-tenant
        │   └── router.py        # event → employee routing
        ├── agents/
        │   ├── factory.py       # build slackagents WorkflowAgent
        │   └── tools.py         # HIVEMIND MCP → function_tool wrapper
        ├── orchestration/
        │   └── master_worker.py # AgentScope Master-Worker delegation
        ├── policy/
        │   └── engine.py        # client-side cache; authoritative gate is in core
        ├── reconcile/
        │   ├── loop.py          # poll /v1/employees every 30s for config drift
        │   └── sharding.py      # consistent-hash workspace assignment
        └── audit.py             # POST to HIVEMIND core audit endpoint
```

## Architecture

All Slack ingress goes through this service:

```
Slack workspace
     │ Socket Mode WS
     ▼
hm-employees (Python)
  ├── SlackGateway (one Bolt app per workspace; tokens from platform_integrations)
  ├── WorkflowAgent pool (one per DigitalEmployee row)
  └── routes inbound events → employee → AgentScope Master-Worker → reply
     │ MCP tool calls (recall, save, slack_post, slack_search, ...)
     ▼
hm-core (Node)
  ├── HIVEMIND MCP server (22 tools + 4 slack:act tools)
  ├── /api/employees/slack-action — action gateway (policy gate + audit + auto-ingest)
  └── memory engine
```

Workers NEVER touch Slack tokens directly. All outbound Slack actions go
through `/api/employees/slack-action` which runs policy + audit + memory
ingest in `hm-core`.

## Build phases

- **2.1** Vendor SlackAgents ✅ (this commit)
- **2.2** Python wrapper shell (FastAPI + Dockerfile + pyproject)
- **2.3** SlackGateway + WorkflowAgent factory + HIVEMIND MCP wrappers
- **2.4** Reconcile loop + status flip (draft → running)
- **2.5** Coolify service entry + deploy
- **3.1** AgentScope Master-Worker integration
- **3.2** Consistent-hash sharding
- **3.3** Metrics + conversations tabs in dashboard
- **3.4** Kill switch + spend tracking
- **3.5** Prometheus + Grafana

## Run locally

```bash
cd employees-service
poetry install
HIVEMIND_CORE_URL=http://localhost:3000 \
  HIVEMIND_API_KEY=hmk_emp_... \
  EMPLOYEE_ID=<uuid> \
  python -m hivemind_employees.main
```

## Run in production

Coolify auto-builds on git push to main. See `scripts/deploy.sh employees`
for manual restart.

Current public admin/health endpoint:

```text
https://core.hivemind.davinciai.eu:8061
```

This endpoint is served by a dedicated Caddy sidecar that proxies to the
internal `hm-employees:8060` service and reuses the existing
`core.hivemind.davinciai.eu` certificate.

## See also

- `docs/architecture/digital-employees-slackagents-plan.md` — full architecture
- `docs/architecture/digital-employees-hermes-plan.md` — shelved alternative
