# Employee viewport correction — 1 October 2026

Frontend source: `774ed3c905ddc3a39560ca2a0f26efc88edafccd` (origin/main).
Worker version: `b0bb7d09-f596-4d2a-aad1-10ec46816663`.
Rollback Worker: `cf04eead-615d-4f1a-8155-415b18bd1700`.

HyperAgents, Hermes and employee playground now use the existing scale-adjusted app viewport height instead of unscaled 100vh. Removed forced 600px minimum on room layouts so lower controls remain reachable on short displays.

Production build compiled successfully. Authenticated company route verified at CSS zoom 0.9: viewport 1204px, room bottom 1204.44px, Sign Out bottom 1197.24px. Scrolled task column to its final task; bottom 1189.88px, fully within viewport. Screenshot: /tmp/hivemind-employee-viewport-fixed.png.

Native Harness runner and its frontend packages were not changed in this release.
