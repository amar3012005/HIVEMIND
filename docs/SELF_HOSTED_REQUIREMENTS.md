# Self-Hosted Enterprise — What We Need From the Customer

> For a Self-Hosted Sovereign deployment where the customer runs their own
> data stores (Qdrant + Postgres) so their memory never leaves their walls.
> This is the exact, minimal set of things they must provide, grounded in the
> env vars the code actually reads (`core/src/vector/qdrant-client.js`,
> `core/prisma/schema.prisma`, `core/src/vector/collections.js`).
>
> Verified against the running production config 2026-06-13.

---

## TL;DR — the minimal ask

| Store | What they give us | Notes |
|---|---|---|
| **Qdrant** | `QDRANT_URL` + `QDRANT_API_KEY` | Collection is auto-created. Must allow a **1024-dim, cosine** collection. |
| **Postgres** | one `DATABASE_URL` | PG 14+, a DB + a role that can create the `hivemind` schema and the `uuid-ossp` + `pgcrypto` extensions. |
| **Redis** | `REDIS_URL` | Required — drives the ingestion/sync job queues (BullMQ). |
| **Embeddings** | a 1024-dim embed endpoint (`EMBEDDING_MODEL_URL` + key) | The real extra dependency for true sovereignty (see §4). |
| **LLM** | `GROQ_API_KEY` (or compatible inference gateway) | Entity-linking, cognition, chat. Their key or their model server. |

**Qdrant + Postgres alone do NOT run the product** — Redis, an embeddings
endpoint, and an LLM are also required. Everything else (the app containers)
we ship.

---

## 1. Qdrant — `URL` + `API_KEY` (that's it)

The vector client reads exactly:

| Env | Required | Default | Meaning |
|---|---|---|---|
| `QDRANT_URL` | ✅ | `http://localhost:9200` | their Qdrant endpoint, e.g. `https://qdrant.internal:6333` |
| `QDRANT_API_KEY` | ✅ | dev placeholder | their Qdrant API key |
| `QDRANT_PER_TENANT` | – | `true` | per-org collections (`org_<id>`), recommended on |
| `QDRANT_COLLECTION` | – | `BUNDB AGENT` | legacy single-collection name; ignored when per-tenant |

**Collections are created by HIVEMIND, not the customer.** On first write per
org we create `org_<orgId>` with the fixed contract (`collections.js`):

- **vector size 1024**, distance **cosine**
- HNSW `m=32`, `on_disk=true`, **int8 quantization**

→ The only hard constraint on their Qdrant: it must accept a **1024-dimensional**
collection. Any Qdrant ≥ v1.7 does. Nothing to pre-create.

```bash
# Customer pre-flight check (proves we can reach + auth):
curl -s https://<their-qdrant>:6333/collections -H "api-key: <KEY>"   # → {"result":{"collections":[...]},"status":"ok"}
```

## 2. Postgres — one connection string + the right role

The whole app connects through a single Prisma datasource
(`schema.prisma`: `url = env("DATABASE_URL")`):

```
DATABASE_URL = postgresql://<user>:<pass>@<host>:<port>/<dbname>?schema=hivemind&connection_limit=20&pool_timeout=30
```

**The least their database must satisfy:**

- **PostgreSQL 14+** (production runs 15).
- A **database** for HIVEMIND.
- A **role** that can:
  - `CREATE SCHEMA hivemind`,
  - `CREATE EXTENSION` for **`uuid-ossp`** and **`pgcrypto`** (the only two
    the migrations need — `001_initial_schema/up.sql`). On managed Postgres
    this means `rds_superuser` (AWS) / `cloudsqlsuperuser` (GCP) / project
    owner (Supabase), **or** pre-install the two extensions and grant the
    app role schema rights.
- We then run **`prisma migrate deploy`** to build every table.

### What they do NOT need (kills common objections)
- ❌ **No `pgvector`** — vectors live in Qdrant, not Postgres.
- ❌ **No Apache AGE** — the initial migration *attempts* `CREATE EXTENSION
  IF NOT EXISTS age`, but production runs fine **without it** (prod PG has
  only `pgcrypto`, `plpgsql`, `uuid-ossp`). The knowledge graph is a plain
  `hivemind.relationships` table; AGE is an optional fallback traversal path.
  → Managed Postgres that can't offer AGE (RDS, Cloud SQL, Supabase) is fine.

### Provisioning SQL (what their DBA runs once)
```sql
-- As a superuser / role with CREATE privileges:
CREATE DATABASE hivemind;
\connect hivemind

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE SCHEMA IF NOT EXISTS hivemind;

-- App role (least privilege; owns the hivemind schema):
CREATE ROLE hivemind_app LOGIN PASSWORD '<strong-pass>';
GRANT ALL ON SCHEMA hivemind TO hivemind_app;
ALTER ROLE hivemind_app SET search_path = hivemind;
-- If the app role itself must run migrations that CREATE EXTENSION, it needs
-- superuser OR you pre-create the extensions above as superuser (recommended).
```
Then set `DATABASE_URL` to that role and run `prisma migrate deploy`.

```bash
# Customer pre-flight check:
psql "$DATABASE_URL" -c "select version();"
psql "$DATABASE_URL" -c "select extname from pg_extension;"   # expect uuid-ossp, pgcrypto
```

## 3. Redis — required (don't forget it)

Ingestion, KB processing, and connector sync run on **BullMQ queues**, which
need Redis. Not optional.

```
REDIS_URL = redis://[:<pass>@]<host>:<port>/0
```
- Redis 6+ (prod runs 7). A single instance is fine. Persistence recommended
  (AOF) so an in-flight ingestion queue survives a restart.

## 4. Embeddings — the real "extra thing" for sovereignty

Vectors are **1024-dimensional** and produced by an external embedding
service the app calls per memory:

| Env | Prod value | Meaning |
|---|---|---|
| `EMBEDDING_MODEL_URL` | `https://embeddings-eu…:4006/embed` | the embed endpoint |
| `EMBEDDING_API_KEY` | (key) | auth |
| `EMBEDDING_DIMENSION` | `1024` | **must stay 1024** to match the Qdrant collection contract |
| `EMBEDDING_PROVIDER` | `litellm` | OpenAI-compatible `/embed` shape |

⚠️ **Sovereignty trade-off:** if a self-hosted customer keeps Qdrant +
Postgres in their VPC but points `EMBEDDING_MODEL_URL` at *our* hosted
embedder, **their text leaves their network on every save** — which defeats
the point. For true self-host they run their own 1024-dim embedder (one
container, e.g. a `bge-m3` / litellm server) inside their VPC. The dimension
**must** be 1024 or the Qdrant collection won't accept the vectors.

## 5. LLM inference — required

Entity-linking, the cognition layer, and chat call an LLM:

| Env | Prod value |
|---|---|
| `GROQ_API_KEY` | (key) |
| `GROQ_INFERENCE_MODEL` | `llama-3.3-70b-versatile` |
| `GROQ_VISION_MODEL` | `meta-llama/llama-4-scout-17b…` (PDF/image OCR) |

Same trade-off as embeddings: their Groq key, or an OpenAI-compatible
inference gateway inside their VPC. Without it, memories still save but get
**no graph edges, no cognition, no chat answers**.

---

## 6. Division of responsibility

| Customer's VPC (their walls) | We ship / operate |
|---|---|
| **Postgres** (their data) | App containers: `hm-core` ×N, `hm-control` |
| **Qdrant** (their vectors) | `hm-employees` (HyperAgents), `hm-hermes` |
| **Redis** | Caddy edge / routing |
| **Embeddings endpoint** (for sovereignty) | Nango (OAuth control plane) |
| **LLM gateway** (for sovereignty) | Docling (doc parsing) |

The app containers are stateless — point their `DATABASE_URL`, `QDRANT_URL`,
`REDIS_URL`, `EMBEDDING_MODEL_URL`, `GROQ_API_KEY` at the customer's
infrastructure and HIVEMIND runs entirely inside their boundary.

## 7. Minimal data-plane the customer stands up (their side)

```yaml
# docker-compose.customer.yml — the FIVE things that hold/touch their data.
# The HIVEMIND app containers connect to these via the env vars above.
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: hivemind
      POSTGRES_USER: hivemind_app
      POSTGRES_PASSWORD: ${PG_PASS}
    volumes: [ "pgdata:/var/lib/postgresql/data" ]
    # uuid-ossp + pgcrypto are bundled with the official image; the migration
    # enables them. No pgvector / AGE image needed.

  qdrant:
    image: qdrant/qdrant:v1.12.4
    environment:
      QDRANT__SERVICE__API_KEY: ${QDRANT_KEY}
    volumes: [ "qdrant:/qdrant/storage" ]

  redis:
    image: redis:7
    command: ["redis-server", "--appendonly", "yes"]
    volumes: [ "redis:/data" ]

  embeddings:               # 1024-dim, OpenAI-compatible /embed (for sovereignty)
    image: <bge-m3-or-litellm-embed-server>
    # must output 1024-dim vectors

  # LLM: either reach their Groq/OpenAI-compatible gateway, or run one here.

volumes: { pgdata: {}, qdrant: {}, redis: {} }
```

Then the HIVEMIND app env points at them:
```
DATABASE_URL=postgresql://hivemind_app:${PG_PASS}@postgres:5432/hivemind?schema=hivemind
QDRANT_URL=http://qdrant:6333
QDRANT_API_KEY=${QDRANT_KEY}
QDRANT_PER_TENANT=true
REDIS_URL=redis://redis:6379/0
EMBEDDING_MODEL_URL=http://embeddings:4006/embed
EMBEDDING_API_KEY=${EMBED_KEY}
EMBEDDING_DIMENSION=1024
GROQ_API_KEY=${LLM_KEY}
```

---

## 8. One-line answer to "what do we need from them?"

> **Qdrant URL + API key** (we make the 1024-dim collection), **one Postgres
> `DATABASE_URL`** to a PG14+ DB whose role can create the `hivemind` schema
> + `uuid-ossp`/`pgcrypto` (no pgvector, no AGE), and a **Redis URL**. For it
> to actually *run* sovereignly they also stand up a **1024-dim embeddings
> endpoint** and provide an **LLM key/gateway**.
