# Digital Employees Playground — End-to-End

Multi-employee collaboration runtime. Each employee runs as an
AgentScope ReActAgent; multiple employees collaborate in a TeamRoom
(phase machine: investigate → propose → review → revise → synthesize).
Frontend exposes both a group session view and 1-on-1 DM panels.

## Frontend entry point

`https://hivemind.davinciai.eu/hivemind/app/employees/playground`

Sidebar: **Playground** (under Digital Employees).

Two modes:

| Mode | What |
|---|---|
| Group session | Pick 2+ employees + brief → TeamRoom run, live transcript |
| DM `<employee>` | One-on-one chat, conversation memory persists in-session |

## Architecture (top-down)

```
EmployeePlayground.jsx
    │
    │  axios w/ session cookie
    ▼
control-plane-server.js
    /v1/team-tasks (POST)            ───┐
    /v1/team-tasks/:id (GET)            │
    /v1/team-tasks/:id/transcript (GET) │── _forwardSidecar()
    /v1/employees/:slug/chat (POST)     │      attaches X-Admin-Token
                                     ───┘      + org_id + requested_by
    │
    ▼
hm-employees:8060 (FastAPI Python sidecar)
    api_team_tasks.router
        POST /v1/team-tasks → background asyncio.Task
            └─ TeamRoom (orchestration/team_room.py)
                ├─ agentscope.pipeline.MsgHub (enable_auto_broadcast=False)
                ├─ EmployeeWorker × N (orchestration/worker.py)
                │     └─ agentscope.agent.ReActAgent (one per employee)
                │           ├─ persona → sys_prompt
                │           ├─ model → OpenAIChatModel via OpenRouter
                │           ├─ formatter → OpenAIMultiAgentFormatter
                │           └─ toolkit → HIVEMIND tools
                ├─ TaskStore — Postgres persistence side-channel
                └─ SlackStreamer — optional milestone cards
    api_employee_chat.router
        POST /v1/employees/:slug/chat
            └─ build_react_agent(emp, api_key) (cached by conv_key)
                  └─ agent.reply(Msg(...)) → consolidated text
```

## Database

Two tables added by `core/prisma/migrations/20260513120000_team_tasks`:

| Table | Purpose |
|---|---|
| `hivemind.team_tasks` | one row per run (brief, roster, status, counters, final_answer) |
| `hivemind.team_task_messages` | transcript: chat / claim / review / revision / synthesis / system |

Two columns added by `20260513140000_employee_role_archetype`:

| Column | Type | Drives |
|---|---|---|
| `digital_employees.role_archetype` | VARCHAR(40) | reviewer / synthesizer selection |
| `digital_employees.peer_review_targets` | TEXT[] | adversarial reviewer bias |

Two columns added by `20260512120000_employee_slack_identity_override`:

| Column | Type | Drives |
|---|---|---|
| `digital_employees.slack_display_name` | TEXT | per-message Slack username override |
| `digital_employees.slack_avatar_emoji` | TEXT | per-message avatar override |

## Deploy

### 1. Sync to server

```bash
ssh prod 'cd /opt/HIVEMIND && git pull origin main'
```

### 2. Migrate

Migrations apply automatically when `hm-core` (re)starts:

```
sh -c "npx prisma generate && npx prisma migrate deploy && node src/server.js"
```

Forced re-run if needed:

```bash
ssh prod 'docker exec hm-core npx prisma migrate deploy'
```

### 3. Restart services

Either via Coolify UI or:

```bash
ssh prod 'cd /opt/HIVEMIND && bash scripts/deploy.sh employees core control'
```

Order matters when running migrations cold:
1. `hm-core` first (applies migrations)
2. `hm-control` (picks up new proxy routes in control-plane-server.js)
3. `hm-employees` (picks up agentscope dep, new routers)

### 4. Frontend (Vercel)

Already auto-deploys on push to `amar3012005/Da-vinci` main.
If alias didn't auto-promote:

```bash
cd /Users/amar/HIVE-MIND/frontend/Da-vinci
vercel promote $(vercel list davinciai-eu | awk 'NR==4 {print $3}')
```

## Required env vars

Already set in `$COOLIFY_ENV` on the server. Verify:

| Var | Why | Default in deploy.sh |
|---|---|---|
| `HIVEMIND_MASTER_API_KEY` | sidecar auth + core → sidecar proxy | required |
| `HIVEMIND_EMPLOYEES_URL` | core → sidecar base URL | `http://hm-employees:8060` |
| `OPENROUTER_API_KEY` | LLM access for ReActAgents | required |
| `DATABASE_URL`, `REDIS_URL` | sidecar persistence + dedup | already set |

## Verify end-to-end

```bash
# 1. Sidecar health
curl https://api.hivemind.davinciai.eu:8040/health
# expect: {"db":"ok","redis":"ok","core":"ok"}

# 2. Verify routes loaded
ssh prod 'docker exec hm-employees curl -sf http://localhost:8060/openapi.json | jq ".paths | keys"'
# expect: ["/admin/reload","/health","/health/deep",
#         "/v1/employees/{slug}/chat",
#         "/v1/team-tasks","/v1/team-tasks/{task_id}",
#         "/v1/team-tasks/{task_id}/transcript"]

# 3. Run a team task from the Playground UI:
#    hivemind.davinciai.eu/hivemind/app/employees/playground
#    Pick 2 employees → brief "say hi as a team" → Run.
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Playground shows "no running employees" | Employees in `draft` / `paused` status | Resume from Digital Employees page |
| Run returns 401 | Master key missing on server | Set `HIVEMIND_MASTER_API_KEY` in `$COOLIFY_ENV`, restart hm-control + hm-employees |
| Run returns 502 from `/v1/team-tasks` | hm-employees not reachable from hm-control | `docker network inspect hivemind` — must share network |
| Transcript stays empty | `agentscope` not installed in sidecar image | `docker exec hm-employees pip show agentscope` |
| ReActAgent LLM errors | OpenRouter key missing | Set `OPENROUTER_API_KEY` on sidecar |
| Same employee posts as "DAVINCI AI" instead of persona | Missing `chat:write.customize` Slack scope | Reinstall app, add scope, refresh tokens |

## Smoke test (CLI, no LLM)

Works without Postgres or network:

```bash
cd /opt/HIVEMIND/employees-service
PYTHONPATH=src python3 -m hivemind_employees.orchestration.smoke \
    --mock --task "verify pipeline" --rounds 1 --slack-dry-run \
    --slack-channel C01 --slack-thread-ts 1.1
```

Expect: 3 mock workers run investigate → propose → review → revise →
synthesize, gate satisfies at round 1, final answer printed.
