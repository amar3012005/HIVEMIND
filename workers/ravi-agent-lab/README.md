# Ravi Cloudflare Agent Lab

This is an isolated proof run for a persistent User & Market Researcher. It is
not connected to production HyperRooms, tenant memory, Flagship, Composio, or
the HIVEMIND control plane.

It demonstrates the Cloudflare Agent runtime with a durable per-agent identity,
bounded public-source research, persisted source receipts, idempotent run IDs,
and an explicit approval boundary for external actions.

`composio_execute` is deliberately report-only in the lab. A future production
adapter must receive a tenant-scoped OAuth connection, a signed work-order
authority grant, and an idempotency key from Core before it can invoke an action.
