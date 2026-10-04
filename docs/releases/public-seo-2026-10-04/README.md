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

## Continuation: public startup and image delivery

- Frontend source: f468054efe091b3f575184887d7664c8aa1b6e18, pushed to Da-vinci main.
- Parent promotion: c6c03bc2, pushed to singulance-main.
- Current Worker: b5484742-94fc-4de5-b0bf-376549b80d2c, 100% traffic.
- Immediate rollback: df344def-012c-4192-bb73-93162929aa79. Previous baseline: 8ef69375-d7ce-4066-a4ba-53ac048fc509.
- Both continuation builds passed the guarded production build and asset verification. Source and current Worker were checked before each cutover. No Core, Harness, Control Plane, database, or security rule was changed.
- Optional PostHog initialization is dynamically loaded only after analytics consent. Consent revocation is rechecked during SDK initialization. Consent preferences and rejection were verified in the live research page.
- Consent-banner entry animation now uses CSS and respects reduced motion. The acceptance button contrast was improved.
- Main JS compressed size fell from 239.65 KB to 132.03 KB (about 45%).
- Responsive AVIF mobile hero variants retain WebP fallback. The 750px hero falls from 80,600 bytes to 50,196 bytes. The matching AVIF preload prevents fetching the WebP unnecessarily in supporting browsers.
- Responsive thesis images reduce the 750px transfer to 65,076 bytes from the 185,942-byte 1080px original. Desktop artwork and motion behavior are retained.
- Nine public initial documents passed H1/canonical/description/schema/indexability checks. Public sitemap XML parsed with nine URLs; robots returned 200. Unknown page and JS probes returned real 404s; app Profile retained noindex. See continuation-http-audit.json. New AVIF asset returns 200 image/avif, and the public HTML advertises the AVIF preload.

### Crawler and Search Console evidence

Cloudflare's verified Search Engine Crawler logs show Googlebot, ASN 15169 Google LLC, requesting public /sitemap.xml at 2026-10-04 02:24:25 CEST and /robots.txt at 02:23:59. The expanded sitemap record reports Not mitigated and cache Hit. This confirms a real Googlebot request and absence of security mitigation for that request; this UI does not expose its HTTP response code, so it does not prove successful sitemap parsing.

Search Console accepted the sitemap resubmission with its success dialog. The report still says Couldn't fetch / Unknown / zero discovered pages. Do not claim successful Google processing. Public XML is valid and reachable; no security protections were weakened. The existing verified domain property was used.

### Continuation lab measurement before the image refinement

https://pagespeed.web.dev/analysis/https-singulancelabs-com/thq3jw08og?form_factor=mobile

Mobile: Performance 75, Accessibility 100, Best Practices 100, SEO 100; FCP 1.7s, LCP 6.2s, TBT 20ms, CLS 0.078, Speed Index 2.7s. No field data. Desktop measurement returned RPC deadline exceeded. LCP is still poor; this is not a passing field Core Web Vitals result. The final image-release measurement is recorded below when complete.

### Final desktop-scene isolation release

- Frontend source: e4bc75cf6edfbb953ae5b6194358297026e16d84, pushed to Da-vinci main.
- Parent promotion: 9409833e, pushed to singulance-main.
- Current Worker: 9aa20e1e-9340-45d1-afea-ba8b1bfb2b4c, 100% traffic. Immediate rollback: b5484742-94fc-4de5-b0bf-376549b80d2c.
- Desktop-only scenes, the field picker, and desktop About content now load through React lazy boundaries only when desktop mode renders. Mobile retains its hero, thesis, navigation and footer; desktop retains its original components. Breakpoint changes still load desktop components on demand.
- Focused ESLint, guarded production compilation, source-head checks and asset verification passed. Live Worker identity was unchanged between baseline and cutover. Main compressed JS remains approximately 132 KB; the optimization removes desktop-only scene dependencies from the mobile route's eager import graph.
- Final HTTP checks passed for all nine canonical pages, one initial H1/title/description/schema per page, sitemap XML, robots, HTTP-to-HTTPS 308, real unknown-page/chunk 404s and private app noindex. See final-http-audit.json.
- Live authenticated Profile reload and public Research navigation rendered after this cutover. No authenticated app, Harness, Core, Control Plane, database or security-rule source changed in this continuation.

Final mobile PageSpeed report, 2026-10-04 03:20 CEST:
https://pagespeed.web.dev/analysis/https-singulancelabs-com/5lzu011rvo?form_factor=mobile

Performance 76; Accessibility 100; Best Practices 100; SEO 100. FCP 1.7s, LCP 5.8s, TBT 90ms, CLS 0.078, Speed Index 2.4s. Exact calculator values: FCP 1703ms, LCP 5803ms, TBT 86ms. These are synthetic runs and vary; compared with the initial run, blocking improved greatly, while LCP remains poor and a passing Core Web Vitals result is not established. No field data is available.

The previous image-release measurement was Performance 76, LCP 6.3s, TBT 60ms:
https://pagespeed.web.dev/analysis/https-singulancelabs-com/qj4e9ayt9v?form_factor=mobile

Remaining external outcome: Search Console sitemap parsing is unconfirmed despite accepted resubmission and a verified Googlebot request with no security mitigation. Do not claim guaranteed rankings or that all nine URLs are indexed. Backlink outreach is not performed; the strategy is recorded in the frontend's docs/seo/public-search-plan.md.

Final desktop PageSpeed measurement returned RPC::DEADLINE_EXCEEDED / context deadline exceeded. No desktop score or passing desktop performance result is claimed.
