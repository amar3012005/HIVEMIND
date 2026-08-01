# Phase 14 - Shared Lead Intelligence

## Production invariant

Prospect discovery is complete only when every returned prospect is persisted to
the organization-scoped shared lead book. Each row must retain a source-grounded
fit reason, a distinctive observed signal, and a discovery-first outreach angle.

## Execution boundary

- Room Intelligence discovers prospects through Google Places and optional public
  contact-page enrichment.
- Qualification copy is derived from the Places category, address, listing
  activity, contact availability, and requested segment. It does not use an LLM
  to invent prospect needs.
- The Employees sidecar sends the complete bounded result to
  `POST /internal/hyper/prospects/bulk` once per tool call.
- Control Plane applies tenant scope server-side, deduplicates company aliases,
  and creates or updates organization memories tagged `prospect` and `lead`.
- Work-order governance requires `records_persisted == records_created` for every
  Places artifact, independent of prompt wording or language.
- `GET /v1/hyper/leads` merges discovered prospect intelligence with later
  campaign and outreach state, so all Rooms and users share one lead source.

## Production proof

The v3 canary turn `f33e955e-0667-48ea-a28e-35dfc46755dc` discovered 20 insurance
prospects in Braunschweig. All 20 were persisted with fit reason, distinctive
signal, and outreach angle. The governed Room result sealed `complete` with
`records_created=20`, `records_persisted=20`, and no gaps.

Playwright verified the Your Leads view at 1440x960 and 430x900. Both viewports
show discovery state, rationale, and outreach angle without horizontal page
overflow.
