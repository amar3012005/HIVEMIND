# Env Var Matrix

Every env var HIVEMIND uses, where it's set, who reads it.

| Var | Value source | Set in | Read by |
|---|---|---|---|
| `DATABASE_URL` | secret | Coolify (hm-core, hm-control), local .env | core, control-plane, prisma migrate |
| `NANGO_URL` | `http://nango:3003` (internal) | Coolify (hm-core) | core/src/connectors/mcp/nango-service.js |
| `NANGO_SECRET_KEY` | UUID v4 from Nango admin `/api/v1/environment/api-keys` | Coolify (hm-core) | nango-service |
| `NANGO_ENCRYPTION_KEY` | base64 32-byte | Coolify (nango) | Nango server (set ONCE, never rotate) |
| `NANGO_PUBLIC_CONNECT_URL` | `https://api.hivemind.davinciai.eu:8043` | Coolify (nango) | Nango server (in connect_link response) |
| `NANGO_SERVER_URL` | `https://api.hivemind.davinciai.eu:8042` | Coolify (nango) | Nango server |
| `REACT_APP_CONTROL_PLANE_URL` | `https://api.hivemind.davinciai.eu:8040` | Vercel | FE theme.js |
| `REACT_APP_CORE_API_URL` | `https://core.hivemind.davinciai.eu:8050` | Vercel | FE theme.js |
| `REACT_APP_NANGO_CONNECT_URL` | `https://api.hivemind.davinciai.eu:8043` | Vercel | FE Connectors.jsx (openConnectUI baseURL) |
| `QDRANT_URL` | internal | Coolify | core |
| `GROQ_API_KEY` | secret | Coolify | LLM-targeted scanner, AgentSwarm |

_(append rows for every new var added)_

## Rules

- Adding env var → add row HERE, in `docker-compose.coolify.yml`, in `.env.example`, set in Coolify/Vercel
- Removing env var → strikethrough row, keep history
- Rotating secret → note date in margin
