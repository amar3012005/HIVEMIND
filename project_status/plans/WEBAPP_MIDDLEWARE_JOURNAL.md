# Webapp Middleware Journal

Date: 2026-03-13

## Objective

Add a non-MCP integration path for webapps like ChatGPT and Gemini so they can use HIVE-MIND through a shared HTTP contract while MCP-native clients continue using the HIVE-MIND MCP server.

## Implemented

### Shared integration helpers

Added:

- `/Users/amar/HIVE-MIND/core/src/integrations/webapp-middleware.js`

This module provides:

- platform normalization
- webapp context response builder
- webapp memory save payload builder
- prompt envelope builder

### API routes

Extended:

- `/Users/amar/HIVE-MIND/core/src/server.js`

New endpoints:

- `POST /api/integrations/webapp/prepare`
- `POST /api/integrations/webapp/store`

The intended flow is:

1. wrapper calls `prepare`
2. HIVE-MIND recalls scoped memory
3. wrapper sends `prompt_envelope` to ChatGPT/Gemini/etc.
4. wrapper calls `store` to persist useful outputs back into memory

### Browser/client SDK

Added:

- `/Users/amar/HIVE-MIND/web/hivemind-web-sdk.js`

This SDK provides:

- `prepareContext(...)`
- `storeMemory(...)`
- `createChatCompletionEnvelope(...)`

### Local wrapper page

Added:

- `/Users/amar/HIVE-MIND/web/webapp-wrapper.html`

Served by HIVE-MIND at:

- `http://localhost:3000/webapp-wrapper`

This page provides a local working surface for:

- selecting ChatGPT/Gemini-style platform mode
- preparing scoped memory context
- inspecting the exact prompt envelope
- storing outputs back into memory

### Tampermonkey localhost bridge

Added:

- `/Users/amar/HIVE-MIND/scripts/tampermonkey-hivemind-web.user.js`

This script injects a lightweight HIVE-MIND panel into ChatGPT and Gemini pages and calls localhost endpoints directly.

### Tests

Added:

- `/Users/amar/HIVE-MIND/core/tests/integration/webapp-middleware.test.js`

Coverage:

- prompt envelope generation
- payload normalization from camelCase/snake_case
- persisted recall flow into webapp context contract

### Docs

Updated:

- `/Users/amar/HIVE-MIND/docs/API_REFERENCE.md`

The API reference now documents:

- webapp middleware endpoints
- wrapper usage flow
- browser SDK example
- local wrapper page
- Tampermonkey bridge

## Architecture Result

HIVE-MIND now supports both:

- MCP-native clients:
  - Claude Desktop
  - Codex
  - Antigravity
- webapp/API wrappers:
  - ChatGPT-style
  - Gemini-style
  - custom browser or desktop shells

Both paths terminate in the same memory engine and retrieval layer.

## Remaining Gaps

- this does not inject directly into proprietary web UIs by itself
- a thin wrapper app, extension, or server-side integration is still needed for ChatGPT/Gemini web
- no OAuth/session-specific auth exchange is implemented for third-party webapps yet
- the Tampermonkey script uses best-effort DOM scraping and is not a hardened production browser extension

## Next Priority

1. harden DOM selectors and composer insertion logic for ChatGPT/Gemini page changes
2. add a production browser extension or local proxy for ChatGPT/Gemini web usage
3. add per-platform save heuristics for auto-capturing important outputs

### Localhost install route

Added a direct localhost-served Tampermonkey install route:

- `/tampermonkey/hivemind-web.user.js`

This avoids manual file import and makes local browser testing simpler while the browser path is still a Tampermonkey prototype rather than a packaged extension.
