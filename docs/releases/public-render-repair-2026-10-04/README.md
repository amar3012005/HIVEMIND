# Public rendering repair — 2026-10-04

## Release

- Frontend: `3b57bb0dbf3a119267c58b5e69afbb562139324f` (pushed).
- Parent source: `d964c88ddfd6b184c5c7a4b56d4fc50309f0666e` (pushed).
- Worker: `0e6ccb8b-9678-4d20-82cb-9c83dbfcd2e9`, deployed at 100%.
- Immediate rollback: `8af252e8-44aa-4bfc-a9bd-5a34b93b6de0`.
- Pre-task rollback: `a379ffc4-b893-4a6f-8297-8e844ed1ed35`.

## Findings and repair

TARA and HyperAgents public routes returned 404. The HIVEMIND product route was treated as private. The app landing initially waited for feature configuration, exposing cookie UI before product content. The previous short crawler fallback was insufficient for inspection.

Twelve canonical public pages now prerender their actual React components at build time. Public HIVEMIND, TARA and HyperAgents routes are available; next/ returns the actual HIVEMIND landing. Public HTML remains visible while lazy client components load. Product links persist after client mount, including in the existing landing hero. Cookie consent is correctly non-modal; preferences remain unchanged. Markdown/text aliases and llms-full contain the rendered public content rather than short overviews.

## Verification

Guarded production build and asset checks passed, with clean pushed source and current Worker checked before each cutover. HTTP audit: twelve pages returned 200, each with one H1 and matching generated Markdown. Live browser confirms next/ renders its existing product landing, with three persistent product links after loading. TARA and HyperAgents public pages render visually. Existing authenticated Profile loaded its account tabs and sidebar.

Direct HIVEMIND text, TARA Markdown, HyperAgents text, and next/index.md redirect verified. Private Profile retains noindex/nofollow/noarchive/nosnippet. No Core, Harness, database or control-plane release; no auth or customer-data permissions changed. Existing public landing illustrations are marketing demonstrations, not authenticated agent traces.

## Remaining edge restriction

next/llms.txt is blocked by Cloudflare before Worker execution (403, browser and curl). The Worker contains a redirect to the canonical public llms file, but cannot execute it for this blocked request. The canonical singulancelabs.com discovery files were verified earlier in this release. No WAF protection was disabled. This endpoint must not be reported as fixed; its edge rule needs separate inspection and a narrowly scoped correction.

See attached audits and the actual live public-page screenshot. No complete performance or private-agent-trace verification is claimed.
