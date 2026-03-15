# MCP Connector Ingestion Journal

Date: 2026-03-13

## Objective

Add a generic MCP ingestion connector to HIVE-MIND so external MCP servers can be used as source connectors, while keeping one internal ingestion contract:

- register external MCP endpoint
- inspect tools/resources
- call tool/resource
- normalize result into HIVE-MIND memory payloads
- enqueue through the existing async ingestion pipeline
- retrieve through persisted recall

## Implemented

### Generic MCP connector layer

- Added endpoint registry:
  - `/Users/amar/HIVE-MIND/core/src/connectors/mcp/registry.js`
- Added MCP client runner using the official SDK:
  - `/Users/amar/HIVE-MIND/core/src/connectors/mcp/runner.js`
- Added orchestration service:
  - `/Users/amar/HIVE-MIND/core/src/connectors/mcp/service.js`

The service now supports:

- endpoint registration
- endpoint listing
- endpoint inspection
- tool/resource execution
- `stdio`, `streamable-http`, and `sse` transport handling
- adapter-based normalization
- async ingest submission

### Source adapters

Added adapter layer:

- `/Users/amar/HIVE-MIND/core/src/connectors/mcp/adapters/index.js`

Implemented adapters:

- `gmail`
- `repository_code`
- `chat_session`
- `linear`

The Gmail adapter uses the existing Gmail normalization logic and maps MCP output into ingestion payloads that end in the shared pipeline.
The Linear adapter maps issues, projects, and documents into the same ingestion payload contract so task-tracker integrations do not need a separate ingest path.

### API surface

Extended:

- `/Users/amar/HIVE-MIND/core/src/server.js`

New routes:

- `GET /api/connectors/mcp/endpoints`
- `POST /api/connectors/mcp/endpoints`
- `POST /api/connectors/mcp/inspect`
- `POST /api/connectors/mcp/ingest`

### HIVE-MIND MCP server surface

Extended:

- `/Users/amar/HIVE-MIND/mcp-server/server.js`

New HIVE-MIND MCP tools:

- `register_connector`
- `inspect_connector`
- `ingest_connector`

This lets an MCP client talk only to HIVE-MIND MCP, while HIVE-MIND itself connects outward to external MCP servers.

### Runtime dependency

Added MCP SDK dependency:

- `/Users/amar/HIVE-MIND/core/package.json`

### Fixture server

Added fake Gmail MCP server for local/runtime validation:

- `/Users/amar/HIVE-MIND/core/src/connectors/mcp/fixtures/fake-gmail-server.js`

Added fake Linear MCP server for validation of work-item ingestion:

- `/Users/amar/HIVE-MIND/core/src/connectors/mcp/fixtures/fake-linear-server.js`

### Tests

Added integration coverage:

- `/Users/amar/HIVE-MIND/core/tests/integration/mcp-connector-ingest.test.js`

This now covers:

- Gmail thread ingestion through MCP
- Linear issue ingestion through MCP

## Validation

### Automated tests

Ran:

```bash
node --test core/tests/integration/mcp-connector-ingest.test.js core/tests/integration/prisma-query-recall.test.js
```

Result:

- `4` passed
- `0` failed

Linear adapter-specific validation:

```bash
node --test core/tests/integration/mcp-connector-ingest.test.js
```

Result:

- `2` passed
- `0` failed

### Live API validation

Validated against `http://localhost:3000`:

1. generated API key
2. registered fake Gmail MCP endpoint
3. inspected endpoint tools
4. ingested Gmail thread through `/api/connectors/mcp/ingest`
5. polled `/api/ingest/status`
6. recalled ingested memory through `/api/recall`

Observed:

- endpoint registration succeeded
- MCP inspection returned tool `gmail_get_thread`
- ingestion job completed successfully
- persisted recall returned the ingested Gmail memory

Confirmed persisted row inside Postgres container:

- project: `project-mcp-live-1773358856`
- source platform: `gmail`
- source message id: `gmail-msg-fixture-1`

### Real remote MCP validation

Validated the real Linear MCP endpoint shape through HIVE-MIND:

1. registered remote endpoint:
   - `https://mcp.linear.app/mcp`
2. rebuilt API runtime with remote transport support
3. inspected endpoint through HIVE-MIND backend

Observed:

- HIVE-MIND reached the real Linear MCP endpoint
- response failed with `401`

Interpretation:

- transport/network path is working
- remaining blocker is Linear authentication, not connector architecture

## What this proves

HIVE-MIND can now use external MCP servers as ingestion adapters instead of bespoke one-off integrations, while still keeping:

- one normalized memory schema
- one async ingestion path
- one persisted retrieval layer

This is the correct direction for enterprise connector expansion.

## Remaining gaps

- adapter coverage is still minimal and fixture-based
- Gmail MCP ingestion is validated with a fake server, not a real Gmail MCP provider yet
- Linear remote MCP connectivity works, but authenticated access is not configured yet
- connector policies, auth storage, and permission boundaries need hardening for production
- graph relationship enrichment during MCP ingest is still limited compared to the target `Updates` / `Extends` / `Derives` design

## Next priority

1. add Linear auth handling for HIVE-MIND-owned remote MCP connections
2. add a real Gmail MCP adapter against an actual Gmail MCP server
3. add repo/code MCP adapter validation against a real code MCP source
4. persist stronger graph-enrichment during connector ingest
5. add connector auth/secret management and policy enforcement
