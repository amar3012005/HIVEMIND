# Feature flags

## `USE_TOOLS_UNIFIED_DAG`

Fail-closed Core env flag for the `use_tools: true` chat path.

| Value | Behavior |
| --- | --- |
| unset / anything except `true` | Legacy connected-only Composio path. Disconnected catalog apps are not planned; `use_connector` is hidden when no ACTIVE accounts exist. |
| `true` | Unified native + Composio DAG. HIVEMIND tools and named apps share one plan. A named app stays in the DAG when disconnected (`connection_required`). Required missing auth pauses dependents as `needs_connection` with a Connect link; independent native/connected steps may complete. Resume retries the same plan after OAuth and refreshes Composio discovery. Writes remain `pendingWrite` drafts. |

Optional Cloudflare Flagship mapping: evaluate the same name and set Core `USE_TOOLS_UNIFIED_DAG` for the request. Default **off**.

Connect-pause/resume: Composio `createConnectLink` → chat continuation (`plan` + completed results + waiting steps) → user Connect → `__retry_connect__` retries the waiting step.
