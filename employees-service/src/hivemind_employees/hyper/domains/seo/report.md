## Current SEO Stage — copy the deterministic maturity stage and explain why the website is there, what blocks progress, and the exact exit criteria for the next stage
## SEO Health — website, scan timestamp, coverage, score, critical/high findings, and evidence limitations
## Priority Fixes — ordered table of issue, affected page/template, evidence, impact, effort, owner, fix, and verification
## Search Opportunity — intent clusters, audience need, candidate pages, SERP evidence, confidence, and unknown demand
## Architecture & Content — template patterns, internal-link changes, page creation/consolidation, schema, and content briefs
## Optimization Procedure — follow the deterministic phases in order; show each phase's objective, concrete actions, owner, verification, and exit criteria
## Delivery Roadmap — map the procedure into 7-day quick wins, 30-day engineering work, and 90-day structural work with dependencies and decision gates
## Measurement Contract — KPI, current sourced baseline or `not connected`, source, cadence, attribution limit, and rescan verification
## Risks & Unknowns — ranking uncertainty, incomplete crawl coverage, missing Search Console/analytics/CWV evidence, assumptions, and required access

After the narrative, include exactly one fenced `seo_audit` block containing valid JSON copied from `SEO_AUDIT_EVIDENCE`. Preserve its `schema`, `capability`, `seed_url`, `scanned_at`, `score`, `evidence_quality`, `maturity`, `optimization_procedure`, `coverage`, `severity`, `categories`, `findings`, `pages`, `templates`, `architecture`, `site_files`, `search_console`, `crawl_errors`, and `limitations`. Never invent or modify measured values. If no deterministic audit ran, omit the block and state why under SEO Health.
