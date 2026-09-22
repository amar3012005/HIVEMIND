# Entity profile projection v1

Entity dossiers are read models over tenant-authorized canonical entities,
claims, and claim evidence. Core/Postgres is authoritative; the Cloudflare
Worker carries identifiers and durable retries only.

Facts are `static`, `dynamic`, `relationship`, or `historical`. Every visible
fact retains a canonical claim and evidence reference. `dynamic_auto` permits
only direct, corroborated dynamic facts; static and relationship facts are
always review-gated in v1. JEV is advisory classification only and cannot
authorize, write, merge, or invent a fact.

The Flagship mode is exact-targeted and defaults to `off`: `shadow`,
`dynamic_auto`, and `review_only` are explicit promotions. `UserEntityIdentityLink`
requires verification and never copies facts into `UserProfile`.
