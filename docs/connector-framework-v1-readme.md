# Connector Framework v1

This document describes the current provider-agnostic connector framework that was added to HIVE-MIND, along with the Gmail-first implementation and the verification status as of 2026-03-20.

## Goal

Build the connector platform once, then add providers like Gmail, Slack, GitHub, Notion, and others as provider modules instead of one-off integrations.

The intended split is:
- control plane handles OAuth and user-facing connection management
- core handles background sync, normalization, dedupe, and memory ingestion
- frontend acts as a control surface for connect, status, resync, and disconnect

## Current Files

Backend framework:
- `/opt/HIVEMIND/core/src/connectors/framework/provider-adapter.js`
- `/opt/HIVEMIND/core/src/connectors/framework/connector-store.js`
- `/opt/HIVEMIND/core/src/connectors/framework/sync-engine.js`

Gmail provider:
- `/opt/HIVEMIND/core/src/connectors/providers/gmail/oauth.js`
- `/opt/HIVEMIND/core/src/connectors/providers/gmail/adapter.js`

Control plane:
- `/opt/HIVEMIND/core/src/control-plane-server.js`

Core API:
- `/opt/HIVEMIND/core/src/server.js`

Frontend:
- `/opt/HIVEMIND/frontend/Da-vinci/src/components/hivemind/app/shared/api-client.js`
- `/opt/HIVEMIND/frontend/Da-vinci/src/components/hivemind/app/pages/Connectors.jsx`

## Intended Architecture

### 1. Provider Adapter Contract

Each provider should implement:
- `fetchInitial`
- `fetchIncremental`
- `normalize`
- `dedupeKey`

The shared sync engine should stay provider-agnostic and only orchestrate:
- fetch
- normalize
- dedupe
- ingest
- checkpoint
- retry/backoff
- token refresh

### 2. Control-Plane OAuth

Current connector routes:
- `GET /v1/connectors`
- `POST /v1/connectors/:provider/start`
- `GET /v1/connectors/:provider/callback`
- `GET /v1/connectors/:provider/status`
- `POST /v1/connectors/:provider/disconnect`
- `POST /v1/connectors/:provider/resync`

These routes are responsible for:
- listing available and connected providers
- starting provider OAuth
- receiving the provider callback
- storing encrypted tokens
- kicking off initial sync
- exposing connection status to the frontend

### 3. Core Sync Engine

Current core route:
- `POST /api/connectors/sync`

The core side is intended to:
- load the provider adapter
- read connector access tokens
- fetch provider data
- normalize records into memory payloads
- dedupe retries/replays
- ingest into persistent memory

### 4. Frontend Control Surface

The frontend currently includes Gmail-oriented connector UI with:
- Connect
- Disconnect
- Sync now
- live polling
- callback success/error toasts

## Gmail Mapping

The current Gmail adapter is designed to map:
- thread subject -> memory title
- message body -> memory content
- labels -> tags
- participants -> tags
- reply continuity -> `Extends`
- long threads -> additional summary memory

It uses:
- Gmail threads API for initial sync
- Gmail history API for incremental sync

## Required Environment Variables

For Gmail OAuth:

```env
GOOGLE_CLIENT_ID=<your-google-client-id>
GOOGLE_CLIENT_SECRET=<your-google-client-secret>
HIVEMIND_CONNECTOR_ENCRYPTION_KEY=<32-char-secret>
```

Control-plane/core integration also still depends on:

```env
HIVEMIND_MASTER_API_KEY=<internal-core-sync-key>
```

## What Was Verified

The following checks were run:

```bash
node --check core/src/control-plane-server.js
node --check core/src/server.js
node --check core/src/connectors/framework/provider-adapter.js
node --check core/src/connectors/framework/connector-store.js
node --check core/src/connectors/framework/sync-engine.js
node --check core/src/connectors/providers/gmail/oauth.js
node --check core/src/connectors/providers/gmail/adapter.js

cd core
node --test tests/control-plane/descriptors.test.js

cd /opt/HIVEMIND/frontend/Da-vinci
npm run build
```

Observed status:
- syntax checks passed
- control-plane descriptor tests passed
- frontend build passed with warnings

## Known Gaps

This framework is not fully complete yet. The main gaps found during verification are:

1. The Gmail adapter import path in `/opt/HIVEMIND/core/src/server.js` appears incorrect.
2. Prisma schema still uses the old `PlatformType` enum and does not clearly allow `gmail`.
3. Cursor/checkpoint persistence is not actually stored yet.
4. Dedupe keys do not match the Gmail source IDs being persisted.
5. Initial sync and resync depend on `HIVEMIND_MASTER_API_KEY` and can silently no-op.
6. The frontend connectors page has descriptor/status field mismatches and stale success-state refresh behavior.

## Readiness

Current readiness should be described as:
- implemented in structure
- verified at syntax/build level
- not yet fully verified end to end for production Gmail sync

## Next Fixes

Recommended next fixes in order:

1. Fix the core Gmail adapter import path.
2. Update the persistence model so provider IDs like `gmail` are valid.
3. Persist cursor/checkpoint state.
4. Align dedupe keys with stored Gmail source IDs.
5. Make sync enqueue fail loudly if master sync auth is unavailable.
6. Fix the frontend connector page data-shape mismatches.

After those are done, run a real Gmail OAuth and sync smoke test before marking Connector Framework v1 as production-ready.

