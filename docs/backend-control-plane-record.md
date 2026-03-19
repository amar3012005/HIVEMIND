# HIVE-MIND Backend Control Plane Record

## Purpose

This document is the clean backend record for the production onboarding layer added on top of the main HIVE-MIND memory engine.

It answers three questions:

1. What was added in the backend
2. How the new service connects to the main HIVE-MIND server
3. What the frontend is expected to consume and present

## Runtime Topology

HIVE-MIND now has two backend roles:

- `core`:
  - the main memory engine
  - owns memory ingestion, retrieval, MCP RPC, connector execution, graph operations, context/profile APIs, and evaluation
- `control-plane`:
  - the onboarding and client bootstrap backend
  - owns login, session handling, organization bootstrap, API key issuance, and MCP/client descriptor generation

In production, the intended topology is:

- public users connect to the `control-plane`
- the `control-plane` connects internally to the `core`
- both services share the same Postgres and Redis infrastructure
- Qdrant remains attached to the `core` memory engine

## What Was Added

### New backend service

- `core/src/control-plane-server.js`

This service provides:

- `GET /health`
- `GET /auth/login`
- `GET /auth/callback`
- `POST /auth/logout`
- `GET /v1/bootstrap`
- `POST /v1/orgs`
- `GET /v1/api-keys`
- `POST /v1/api-keys`
- `POST /v1/api-keys/:id/revoke`
- `GET /v1/clients/descriptors`
- `GET /v1/clients/descriptors/:client`

### Supporting modules

- `core/src/control-plane/descriptors.js`
  - builds install-ready MCP configs for Claude, Antigravity, VS Code, and remote MCP
- `core/src/control-plane/session-store.js`
  - stores auth state and user sessions using Redis when available, with safe fallback behavior
- `core/src/control-plane/zitadel.js`
  - handles the ZITADEL OIDC exchange and user resolution flow
- `core/src/auth/api-keys.js`
  - creates, hashes, authenticates, lists, and revokes persisted API keys in Prisma/Postgres

### Core server connection update

- `core/src/server.js`

The main HIVE-MIND server now accepts persisted Prisma-backed API keys issued by the control-plane, not only the legacy local key store.

That means keys minted in the control-plane are immediately usable against:

- memory APIs
- search APIs
- MCP APIs
- connector endpoints already exposed by the core

### Deployment/container wiring

- `Dockerfile.control-plane`
- `docker-compose.coolify.yml`

The compose stack now includes a dedicated `control-plane` container alongside the main `app` container.

## How The Control Plane Connects To The Main HIVE-MIND Server

The connection contract is env-driven.

Primary env:

- `HIVEMIND_CORE_API_BASE_URL`

Fallbacks:

- `HIVEMIND_API_URL`
- final default: `https://api.hivemind.davinciai.eu`

This is implemented in:

- `core/src/control-plane-server.js`

Behavior:

- the control-plane never hardcodes the production API host
- descriptor generation uses the configured core API base URL
- bootstrap health checks also use that same core API base URL
- frontend clients receive this resolved value through bootstrap and descriptor endpoints

In other words:

- the `control-plane` is the public onboarding backend
- the `core` is still the main HIVE-MIND engine
- the control-plane points to the core through `HIVEMIND_CORE_API_BASE_URL`

## Data Ownership

### Postgres

Shared by both services.

Used for:

- users
- organizations
- user-organization memberships
- API keys
- memory metadata and graph-linked relational state

### Redis

Used by the control-plane for:

- auth state
- session storage

Used by the broader HIVE-MIND stack for:

- hosted MCP state
- cache/session style coordination where enabled

### Qdrant

Owned by the main `core` server, not the control-plane.

Used for:

- vector search
- semantic retrieval
- cross-platform memory recall

## End-To-End User Flow

The intended production user flow is:

1. User opens the product website
2. Frontend sends them to `GET /auth/login`
3. ZITADEL completes login and returns through `GET /auth/callback`
4. Frontend calls `GET /v1/bootstrap`
5. If no org exists, frontend calls `POST /v1/orgs`
6. Frontend calls `POST /v1/api-keys` to mint the user key
7. Frontend reads `GET /v1/clients/descriptors` or `GET /v1/clients/descriptors/:client`
8. User copies the generated Claude, Antigravity, VS Code, or remote MCP config
9. Those clients connect directly to the main HIVE-MIND core API

This means the control-plane is the onboarding broker, while the core remains the execution engine.

## Verified Docker Behavior

The following flow was validated in Docker:

- control-plane container started successfully
- core container started successfully
- mock OIDC login redirect worked
- auth callback created a real session cookie
- bootstrap returned user and org state
- API key creation returned a real persisted API key
- descriptor generation returned live client configs
- the issued API key successfully created a memory in the core
- the issued API key successfully queried `/api/search/quick`
- the issued API key successfully called `/api/mcp/rpc` for `initialize` and `tools/list`

One migration caveat was discovered during validation:

- `prisma db push` alone did not install the raw SQL function `acquire_memory_user_lock(UUID)`
- applying `core/prisma/migrations/20260312100000_memory_engine_correctness/migration.sql` resolved the issue

## Frontend Expectations

The frontend does not need to own memory logic.

Its job is to present a clean control surface over the control-plane and selected core endpoints.

### Required frontend surfaces

- Sign in / sign out
- Workspace creation
- API key management
- Client install/config generation
- Connector and MCP status
- Context/profile visibility

### Minimum frontend pages

#### 1. Auth and bootstrap

Consumes:

- `GET /auth/login`
- `GET /v1/bootstrap`
- `POST /v1/orgs`
- `POST /auth/logout`

UI outcome:

- show whether the user is signed in
- show whether an org/workspace exists
- move the user into setup if onboarding is incomplete

#### 2. API key management

Consumes:

- `GET /v1/api-keys`
- `POST /v1/api-keys`
- `POST /v1/api-keys/:id/revoke`

UI outcome:

- create key
- display key once
- list existing keys
- revoke keys

#### 3. Cross-platform install page

Consumes:

- `GET /v1/clients/descriptors`
- `GET /v1/clients/descriptors/:client`

UI outcome:

- show Claude config
- show Antigravity config
- show VS Code config
- show remote MCP config
- provide one-click copy and install guidance

#### 4. Memory health and trust surface

Consumes from core:

- `/health`
- `/api/context`
- `/api/profile`
- `/api/search/quick`
- connector status endpoints
- evaluation endpoints

UI outcome:

- show that the backend is healthy
- show current profile/context state
- show search is working
- show connector and evaluation trust signals

## What The Frontend Should Not Do

- It should not store raw long-term memory itself
- it should not duplicate API key auth logic
- it should not implement memory retrieval rules client-side
- it should not hardcode the core API domain

Instead:

- fetch the core API base from bootstrap or server-config
- use descriptor endpoints as the source of truth for MCP configs
- treat the control-plane as the customer-facing backend

## Production Env Contract

Important envs:

- `HIVEMIND_CORE_API_BASE_URL`
- `HIVEMIND_API_URL`
- `HIVEMIND_CONTROL_PLANE_PUBLIC_URL`
- `HIVEMIND_CONTROL_PLANE_SESSION_SECRET`
- `ZITADEL_ISSUER_URL`
- `ZITADEL_CLIENT_ID`
- `ZITADEL_CLIENT_SECRET`
- `ZITADEL_REDIRECT_URI`
- `DATABASE_URL`
- `REDIS_URL`

Recommended production shape:

- control-plane public host:
  - example: `https://hivemind.davinciai.eu`
- core API public host:
  - example: `https://api.hivemind.davinciai.eu`

That lets the onboarding website and the memory engine stay separately deployable while remaining linked through env config.

## Current State

The backend foundation is now in place for:

- self-serve onboarding
- persisted API key issuance
- cross-platform MCP descriptor generation
- main-core API authentication using control-plane-issued keys
- production containerization for both backend roles

The next frontend milestone is not new backend invention. It is productizing the existing contract cleanly.
