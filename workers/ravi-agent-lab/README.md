# Ravi Cloudflare Agent Lab

This is an isolated proof run for a persistent User & Market Researcher. It is
not connected to production HyperRooms, tenant memory, Flagship, Composio, or
the HIVEMIND control plane.

It demonstrates the Cloudflare Agent runtime with a durable per-agent identity,
bounded public-source research, persisted source receipts, idempotent run IDs,
an independent reviewer Agent RPC, Cloudflare Browser capture with R2 screenshot
artifacts, and an explicit approval boundary for external actions.

Current capability status:

| Capability | Lab status | Production integration gate |
| --- | --- | --- |
| Durable Agent state, Agent RPC, Workers AI, Browser, R2, observability | live-tested | none; still not the business ledger |
| WebSockets and scheduling | Agent SDK supported, not connected to a UI in this lab | authenticated room ticket and frontend subscription |
| Workflows | supported, not used for this fast synchronous smoke run | Core-owned work order/checkpoint contract |
| Sandbox | intentionally omitted from a market-research smoke run | explicit command policy and approval gate |
| MCP and Composio | deliberately non-executing | tenant OAuth connection, allowlisted tool, authority grant and idempotency key |
| AI Search | deliberately unbound | isolated tenant index and retention policy |

`composio_execute` is deliberately report-only in the lab. A future production
adapter must receive a tenant-scoped OAuth connection, a signed work-order
authority grant, and an idempotency key from Core before it can invoke an action.
