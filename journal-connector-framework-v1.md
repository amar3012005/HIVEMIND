---

## 2026-03-20 UTC - Connector Framework v1 Verification

### Summary

Verified the new provider-agnostic connector framework and Gmail-first implementation with parallel code review, syntax checks, backend descriptor tests, and a frontend production build.

This is not a full "everything passes" sign-off yet. The main framework surface exists, but the verification found several implementation gaps that should be fixed before calling Gmail connector sync production-ready.

### What Exists

Backend framework files:
- `/opt/HIVEMIND/core/src/connectors/framework/provider-adapter.js`
- `/opt/HIVEMIND/core/src/connectors/framework/connector-store.js`
- `/opt/HIVEMIND/core/src/connectors/framework/sync-engine.js`

Gmail provider files:
- `/opt/HIVEMIND/core/src/connectors/providers/gmail/oauth.js`
- `/opt/HIVEMIND/core/src/connectors/providers/gmail/adapter.js`

Control-plane connector routes in `/opt/HIVEMIND/core/src/control-plane-server.js`:
- `GET /v1/connectors`
- `POST /v1/connectors/:provider/start`
- `GET /v1/connectors/:provider/callback`
- `GET /v1/connectors/:provider/status`
- `POST /v1/connectors/:provider/disconnect`
- `POST /v1/connectors/:provider/resync`

Core sync route in `/opt/HIVEMIND/core/src/server.js`:
- `POST /api/connectors/sync`

Frontend Gmail integration surface:
- `/opt/HIVEMIND/frontend/Da-vinci/src/components/hivemind/app/shared/api-client.js`
- `/opt/HIVEMIND/frontend/Da-vinci/src/components/hivemind/app/pages/Connectors.jsx`

### Verification Performed

Parallel verification was done with subagents for backend and frontend review.

Direct checks run locally:
- `node --check core/src/control-plane-server.js`
- `node --check core/src/server.js`
- `node --check core/src/connectors/framework/provider-adapter.js`
- `node --check core/src/connectors/framework/connector-store.js`
- `node --check core/src/connectors/framework/sync-engine.js`
- `node --check core/src/connectors/providers/gmail/oauth.js`
- `node --check core/src/connectors/providers/gmail/adapter.js`
- `cd core && node --test tests/control-plane/descriptors.test.js`
- `cd frontend/Da-vinci && npm run build`

Observed results:
- backend syntax checks passed
- control-plane descriptor tests passed
- frontend production build completed successfully
- frontend build still reports existing ESLint warnings in the Hivemind app, but no build-blocking errors

### Verified Strengths

- The provider-agnostic framework structure is in place.
- Gmail OAuth URL building and code exchange are implemented.
- The Gmail adapter contains thread fetch, history-based incremental fetch, body extraction, label/tag mapping, and thread-summary logic.
- The control-plane and frontend APIs line up for starting OAuth and polling connector state.
- The connector status vocabulary is mostly consistent across backend and frontend.

### Verification Findings

These issues were found during review:

1. Core sync route imports the Gmail adapter from the wrong relative path.
- In `/opt/HIVEMIND/core/src/server.js`, the dynamic import points at `../connectors/providers/gmail/adapter.js`.
- Since `server.js` is already in `core/src`, this likely resolves outside `core/src/connectors/...`.

2. Prisma schema does not currently support `platformType = "gmail"` as written.
- `/opt/HIVEMIND/core/src/connectors/framework/connector-store.js` writes provider names like `gmail`.
- `/opt/HIVEMIND/core/prisma/schema.prisma` still constrains `PlatformType` to the older enum values.

3. Cursor/checkpoint persistence is claimed but not actually persisted.
- `SyncEngine` passes cursor-related data into `ConnectorStore.updateStatus(...)`.
- `ConnectorStore.updateStatus(...)` currently ignores `cursor` and `syncStats`.
- `ConnectorStore.upsertConnector(...)` accepts `cursor` and `metadata` but does not store them.

4. Dedupe logic does not line up with Gmail source IDs.
- Gmail memories persist per-message source IDs.
- `SyncEngine` dedupes using thread-level keys like `gmail:thread:<threadId>`.
- That means persisted dedupe checks will not reliably match existing Gmail message ingests.

5. Control-plane sync enqueue is still conditional on `HIVEMIND_MASTER_API_KEY`.
- Initial sync and manual resync silently become no-ops if that env var is missing.
- The resync route can still return success even if no sync request was actually sent.

6. Frontend connector page has several integration mismatches.
- Descriptor payloads are read with the wrong shape.
- MCP endpoint status reads `endpoints` while the backend returns `statuses`.
- Endpoint table expects fields that the backend does not return.
- OAuth status refresh is delayed until the next poll after callback.
- OAuth connector fetch failures are swallowed and hidden behind static fallback UI.
- Stats row still uses the static connector list instead of the merged live list.

### Conclusion

Connector Framework v1 is partially implemented and build-verified, but not fully production-ready as a Gmail connector system yet.

Current status:
- framework shape: present
- Gmail provider surface: present
- frontend Gmail card and OAuth wiring: present
- syntax/build validation: passed
- end-to-end Gmail sync correctness: not yet verified safe
- production-readiness: blocked by the findings above

### Follow-Up

Before public rollout, fix:
- core adapter import path
- Prisma enum/storage model for connector providers
- cursor persistence
- dedupe key strategy
- control-plane resync truthfulness and master-key dependency handling
- frontend descriptor/status field mismatches

