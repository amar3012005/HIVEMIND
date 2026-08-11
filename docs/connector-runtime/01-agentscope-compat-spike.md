# Connector Runtime V1 — Phase 1: AgentScope MCP compatibility spike

**Status: PASS (8/8), executed in the live `hm-employees` image.** Disposable
fixture: `spikes/phase1_agentscope_mcp_spike.py`. No AgentScope upgrade; no
production code touched.

## Headline finding — the plan's central risk is void

The plan (drafted against the AgentScope `2.0.5dev` docs) assumed native
stateless-HTTP MCP registration was a **2.x-only** feature and therefore
`mcp_projection.py` would have to hand-write generic Python functions per tool.

**Reality: the running image already ships `agentscope 1.0.21`** (this is what
the `^1.0.19` pin resolves to), and it has a complete native MCP module:

- `agentscope.mcp.HttpStatelessClient(name, transport="streamable_http", url, headers=…, timeout=…, sse_read_timeout=…)` — disposable, new session per call (exactly the "stateless" model the plan wants for horizontally-scaled room workers).
- `Toolkit.register_mcp_client(mcp_client, group_name="…", enable_funcs=[…], disable_funcs=[…], preset_kwargs_mapping=…, postprocess_func=…, namesake_strategy=…, execution_timeout=…)` — registers MCP tools into a named group with per-tool filtering and per-call timeout.
- `Toolkit.remove_mcp_clients(...)`, `create_tool_group(active=False)`, `update_tool_groups([...], active=True)`.

**Consequence for the design:** `mcp_projection.py` needs **zero** per-provider
Python code. The HyperAgents projection (plan §5, Phase 6) becomes:

```python
tk.create_tool_group(connector_id, description=summary, active=False)   # inactive until Director selects it
client = HttpStatelessClient(
    name=connector_id,
    transport="streamable_http",
    url=f"{CORE_MCP_BASE}/mcp/connectors/{connector_id}",
    headers={"Authorization": f"Bearer {capability_token}"},           # 5-min cap token (plan §6)
)
await tk.register_mcp_client(
    client, group_name=connector_id,
    enable_funcs=granted_tool_names,                                    # grant-filtered (plan §5/§6)
    execution_timeout=deadline_seconds,                                # runtime deadline maps natively
)
```

This deletes the entire "wrap returned schemas as generic Python functions"
step from the plan and removes a whole class of schema-drift risk.

## Assertions proven (real execution, exit 0)

| # | Assertion | Result |
|---|---|---|
| A | Native `tools/list` returns synthetic tools with no wrapper | PASS — `['synthetic__echo','synthetic__slow']` |
| A2 | Canonical `<connector>__<operation>` names fit tool-name limit (≤64) | PASS — max len 15 |
| B | Schemas are **hidden** while the group is inactive (`get_json_schemas()` empty) | PASS |
| C | Invoking a tool in an **inactive** group is refused (`FunctionInactiveError`) | PASS |
| D | Activating the group makes the schema visible | PASS |
| D2 | `tools/call` through the group returns a proper `ToolResponse` | PASS — `echo:phase1` |
| E | 8 concurrent `tools/call` all succeed (async concurrency) | PASS |
| F | Per-call `execution_timeout` yields a structured error, not a hang | PASS |

MCP protocol version negotiated by the 1.0.21 client: **`2025-11-25`** (this is
the compat revision the gateway must speak; do not switch without re-running
this spike).

## Implications carried into later phases

1. **Gateway transport (Phase 5):** `POST /mcp/connectors/:connectorId` must be a **streamable-HTTP MCP endpoint** speaking protocol `2025-11-25`, accepting `Authorization: Bearer <capability-token>`. The stateless client opens+closes a session per call, so the gateway must be genuinely stateless (no per-session server state) — matches plan §6.
2. **Inactive groups are native** — the Director cutover (Phase 7) keeps tool groups inactive until selected purely via `create_tool_group(active=False)` + `update_tool_groups`. No custom gating needed.
3. **Grant filtering is native** — `enable_funcs` enforces the per-room tool grant on the client side; the gateway still enforces authoritatively server-side (defence in depth).
4. **Deadline is native** — `execution_timeout` gives a client-side deadline; the runtime pipeline (plan §4 step 14) remains the authoritative server-side deadline.
5. **Cold-inspection latency (plan §2 "~20s per connector") is avoidable** — because the gateway returns trusted canonical manifests, `tools/list` is a single fast Core round-trip, not an upstream provider inspection.

## What this spike did NOT prove (deferred, honest)

- Real capability-token validation on the gateway (Phase 5 builds the gateway; the spike server was unauthenticated).
- Behaviour under the actual Director/room lifecycle (Phase 6/7).
- AgentScope 2.x native `MCPClient`/Toolkit parity (Phase 12, explicitly deferred).

## Verdict

Phase 1 acceptance met: *one synthetic MCP connector invoked through an inactive
AgentScope group, with no provider-specific wrapper.* The MCP projection path is
**simpler and lower-risk than the plan assumed**. Proceed to Phase 2 (runtime
contracts + Gmail read plugin).
