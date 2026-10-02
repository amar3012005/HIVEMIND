# Static chunk recovery — 2 October 2026

Frontend SHA: 3b51cc9fe3051cf1028ea378135fd24a917fd017.
Worker version: 9661c7e9-ae56-44a4-9ffa-de413ffd3db6.
Prior Worker: e06a97bf-d218-4a09-9ec0-63b6ea658f4d.

Changes: route /static/* through the executable response guard; reject HTML in executable service-worker responses; use service-worker cache hive-shell-v7; revalidate static requests against network to discard HTTP-cached HTML/404 responses.

Verification: production build passed. Exact 9495.447b4e54.chunk.js returned 200 text/javascript; deliberately missing static chunk returned 404 text/plain. Production sw.js contains v7 and cache reload. The same authenticated Chrome tab that previously rendered the chunk error now renders SINGULANCE company profile, tasks, documents and room navigation after reload. Screenshot: /tmp/company-chunk-fixed.png.

Scope: Da-vinci Worker and service worker only; no native Harness runtime rollback or Core changes. Browser-extension content.js and contentscript.js warnings are outside this asset delivery change.
