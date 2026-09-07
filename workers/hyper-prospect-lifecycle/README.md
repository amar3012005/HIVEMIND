# Generalized HyperAgents prospect lifecycle

This Cloudflare Workflow runs the room-neutral prospecting contract using only opaque organization, user, room, turn, and job identifiers. Core/PostgreSQL remains authoritative for contracts, candidates, approvals, receipts, and promotion decisions.

The default `shadow` mode cannot execute outreach or persist contacts into the current lead book. It discovers (or records the intended provider lane), normalizes, verifies, qualifies, compares against the existing room result, and persists a parity receipt. Promotion is capability-specific and requires measured thresholds; feature-off/current behavior remains available throughout the migration.
