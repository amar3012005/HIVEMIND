# Public agent readiness release — 2026-10-04

## Release identity

- Public site: https://singulancelabs.com
- Frontend source: c349bda55a01ecc10422a814b50a579b54a53d27 (pushed).
- Parent promotion: 682fba75a8ae515a3a3368878d1bd224de460cc7 (pushed).
- Live Worker: d3fc49ce-4dac-4081-8ddc-02743b9ca945, 100%.
- Immediate rollback: 9aa20e1e-9340-45d1-afea-ba8b1bfb2b4c.
- Guarded build and asset verification passed. Current source and live deployment were checked before cutover. No Core, Harness, database or control-plane deployment.

## Implemented and verified

RFC 8288 Link discovery, RFC 9727 API catalog, ARD catalog, a card describing the existing authenticated Core MCP server, a public research skill with a verified SHA-256, feature-detected read-only WebMCP public-page discovery, content-signal preferences, and regenerated llms files without stale links.

Nine canonical public pages negotiate text/markdown with Vary: Accept and support /index.md aliases. They explicitly identify their text as overviews and link to the complete original pages. HTML remains the browser default. Private discovery endpoints and unknown well-known protocols return real 404s. No private information is embedded in discovery documents.

Public guides and every Markdown overview direct authorized users/agents to https://next.singulancelabs.com/ and MCP setup at /hivemind/app/mcp. This advertises a workspace entry point; it does not generate artificial visits or bypass authentication. MCP remains https://core.singulancelabs.com/api/mcp and requires authorization.

Focused module/Worker checks passed, including absent Accept headers, q=0 negotiation, HEAD, private-host isolation, and unknown path 404s. All nine live Markdown aliases matched their negotiated responses; skill digest matched. Live authenticated Profile rendered after deployment, with existing account sections and navigation present.

## DNS discovery

Added exactly one new HTTPS ServiceMode record; no existing address, tunnel, mail or routing records were modified:

    _index._agents.singulancelabs.com HTTPS 1 singulancelabs.com. alpn="h2,h3" port="443"

Cloudflare dashboard confirmed 77 records (previously 76). Cloudflare DoH returned the record and the scanner validated ServiceMode syntax. Public RDAP identifies Cloudflare as registrar. Managed DNSSEC was enabled; dashboard reports automatic DS publication is pending. DNSSEC signatures (RRSIG) are now returned for the discovery record. The .com parent does not yet return a DS record and the validating resolver still reports AD=false; end-to-end DNSSEC validation is not yet claimed. Existing HTTP Link headers point to the AI catalog; no unassigned endpoint SvcParam was invented.

## Scanner outcome and limits

Initial scan: Level 1 Basic Web Presence. Released scan: Level 5 Agent-Native, 80/100 in the official UI. The post-DNS scan detects the new record but DNSSEC is still pending.

Remaining authentication findings:

- The public homepage is not a protected OAuth resource. Its discovery redirects to the real protected Core MCP metadata, whose resource identifier is correctly Core /api/mcp. The homepage scanner rejects that identifier as a mismatch. Do not relabel the protected resource to the public homepage just to satisfy the scanner.
- /auth.md now serves actual Markdown and documents existing PKCE OAuth and API-key authentication. WorkOS-style agent_auth registration is not implemented in the existing authorization server; no identity/credential protocol was fabricated.
- A2A is not implemented; no card advertises a nonexistent endpoint. Payment protocols and outbound bot signing are conditional, not implemented merely to improve the score.

Separate verified backend issue: https://core.singulancelabs.com/v1/chatgpt/openapi.yaml returns 500 because /app/chatgpt-adapter/openapi.yaml is missing. It is not advertised as a working OpenAPI integration by this release. Core was not changed.

No claim is made that every experimental protocol is supported, that the private app should be crawled, or that agent discovery guarantees traffic/rankings. Earlier SEO and current authenticated app behavior remain included.
