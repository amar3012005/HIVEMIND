# Public SEO release — 2026-10-04

Public site: https://singulancelabs.com. The app at next.singulancelabs.com remains private/noindex.

## Release

- Frontend source: d81fb9b763525d432ccf3d790fcfa56e172823c8, pushed to Da-vinci main.
- Parent gitlink promotion: 411666a5, pushed to singulance-main.
- Live Worker: 8ef69375-d7ce-4066-a4ba-53ac048fc509, 100% traffic.
- Previous compatible Worker: 3ca2e302-f31e-4109-ae16-00f4da7b0234.
- Original rollback Worker: 49c48db6-5308-47c4-8308-009405cea914.
- Source and live-version guards passed before cutover. Only the outer frontend Worker changed; no Harness, Core or database deployment.

## Implemented

Generated nine-URL sitemap, standards-compliant robots, unique canonical/title/description/OG metadata, compressed OG image, truthful Organization/WebSite/WebPage/breadcrumb schema, public crawlable route summaries and internal links, real 404s, HTTPS upgrade and normalization of known public slugs. Private route protection remains.

Public navigation no longer links to nonexistent placeholder products, About/Demo/Terms or app-store downloads. Actual research links are crawlable anchors. Public headings and image alternatives were corrected. The static mobile hero loads first, with motion available through Play/Pause; desktop motion remains. Responsive mobile artwork uses 450/750/900px images. Footer text contrast and reserved image dimensions were improved.

The existing authenticated Profile rendered after the main SEO release. The public Research DOM check after the final release has one H1/canonical, no missing image alt attributes and no horizontal overflow at the normal desktop viewport. Earlier 375px homepage/research checks showed no horizontal overflow; the later browser viewport override was unreliable, so the final mobile synthetic run is the additional mobile check.

## Live measurements

PageSpeed mobile report: https://pagespeed.web.dev/analysis/https-singulancelabs-com/al48pvw5cb?form_factor=mobile

| Metric | Initial | Final |
| --- | --- | --- |
| Performance | 44 | 75 |
| SEO | 100 | 100 |
| Accessibility | 96 | 96 |
| Best Practices | 100 | 100 |
| FCP | 1.7s | 1.7s |
| LCP | 5.2s | 6.4s |
| Total blocking time | 33,610ms | 100ms |
| CLS | 0.078 | 0.078 |
| Speed index | 5.7s | 2.5s |

These are separate synthetic runs on emulated Moto G/slow 4G, not field Core Web Vitals. Blocking improved substantially; LCP is still poor and did not improve. A future public-entry bundle reduction/full article prerender should be measured independently; do not represent this as a complete CWV pass. Search Console has no field data.

All nine initial public HTTP documents returned 200 with one H1/canonical/description/schema and indexable robots. Sitemap/robots returned 200; XML parsed with nine URLs. Unknown pages and missing JS chunks returned 404. App root retained X-Robots-Tag noindex. See live-http-audit.json.

## Search Console outcome and unresolved items

- Domain ownership already verified. Homepage inspection explicitly says URL is on Google and Page is indexed, served over HTTPS.
- Sitemap submission accepted, but its report says Could not fetch / Sitemap could not be read / zero discovered pages. No specific fetch status is exposed.
- Public homepage, robots and sitemap return 200 to browser/Googlebot/Google Inspection user agents. Public XML is valid. PageSpeed successfully fetches the site.
- The only inspected Cloudflare custom rule blocks discovery files on next/admin/icarus private hosts. It does not match the public primary host, and was preserved.
- Search Console live test and recrawl submission return generic Something went wrong / Try again later. The recrawl was not accepted. The cause is not established; do not claim a successful Google sitemap read or new index inclusion.
- Approved Terms/DPA/legal-notice content is still required before adding those destinations. No legal documents or certification claims were invented.
- Backlink strategy is docs/seo/public-search-plan.md in the frontend worktree. No outreach or paid links were sent.

The strategy's earlier AVIF-preload note is superseded by the final responsive WebP preload. Homepage metadata and initial summaries are delivered at the edge for users and bots alike; these summaries are not full server rendering of every research article.
