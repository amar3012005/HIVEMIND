# Progressive decision gateway prototype

The decision gateway lets HIVE Chat ask a typed decision model which capability to expose next. It does not plan a workflow or execute tools. DeepSeek Harness and Legacy keep their existing agent loops, argument generation, approvals, receipts, and final answer behavior.

The shared implementation is `core/src/agent/decision-gateway.js`. `createDecisionRuntimeAdapter` binds it to either runtime and translates the semantic recall policy into that runtime's supported fields. A provider error, timeout, malformed response, low probability, low margin, rejected tool, or disconnected-tool selection opens a per-turn circuit breaker. The adapter then calls the existing selector with the same query, discovery result, and receipts for the rest of that turn.

`decision-gateway-service.js` is the shared server-owned provider boundary. It
supports `off`, `shadow`, and `active` modes. Legacy chat invokes it directly
before each model step. The native runner calls the authenticated
`/internal/v1/harness-chat/core/decision` route; tenant scope comes only from
the runner service token. The companion Cordis plugin lives in the Harness
repository as `@deepseek-ai/dsh-hivemind-decision-gateway` and narrows the
first request with `agent.ctx.tools.restrict()`. No agent loop is patched.

If the decision service throws or returns `defer`, Legacy immediately supplies
its current two-gateway surface and Harness leaves its current full tool
surface unchanged. Shadow mode never changes a tool surface.

Explicit operational app requests enter Composio Search directly. The gateway receives a bounded projection of the returned candidates and connection state, selects one current action, and exposes the selected authoritative schema to the chat model. Writes remain approval-gated. HIVE context and direct saves retain their existing tools; the gateway selects only the capability family or recall policy.

Run the focused keyless checks with:

```sh
node --test core/tests/unit/decision-gateway.test.js core/tests/unit/decision-gateway-service.test.js core/tests/unit/harness-chat-runner-service.test.js
```

Run the live provider evaluation with an OpenRouter key that is entitled to the Decisions API:

```sh
cd core
OPENROUTER_API_KEY=... npm run eval:decision-gateway
```

The 2026-09-20 live evaluation proved:

- a compound Gmail, HIVE save, and Instagram request selected Composio first with probability `1.00`;
- live Composio discovery selected connection management for disconnected Gmail with probability `0.99`;
- a temporal evidence request selected evidence retrieval, newest ordering, valid time, and superseded history, then translated to both runtime schemas;
- a connected read exposed only `GMAIL_FETCH_EMAILS` to the main chat model, which called it and answered from its bounded receipt;
- a progressive compound fixture selected Gmail read (`0.99`), HIVE save (`0.83`), Composio (`1.00`), and Instagram write (`0.88`) from the original request plus completed receipts;
- a write selection stopped at `approval_required` without execution;
- a provider `401` and uncertain decisions used the existing selector during the same turn and suppressed further decision calls for that turn.

The production container's current `OPENROUTER_API_KEY` returned `401 User not found` for the Decisions endpoint during this evaluation. The separately supplied evaluation key succeeded. Production activation therefore requires replacing or routing the decision credential before enabling the feature flag.
