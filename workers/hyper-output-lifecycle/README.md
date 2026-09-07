# HyperAgents output lifecycle

Cloudflare Workflow authority for deterministic HyperAgents output jobs.

The Workflow receives only scoped opaque identifiers. PostgreSQL stores the output contract, sealed source, rendered bytes, validation state, and digest-bound receipt. Durable stages are prepare, render, validate, and persist. External delivery is outside artifact generation and requires approval matching the immutable artifact digest.

Report output supports HTML and Playwright PDF rendering. Other registered output skills fail closed until their native renderer is connected; no format is silently substituted.
