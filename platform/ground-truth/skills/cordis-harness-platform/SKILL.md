---
name: cordis-harness-platform
description: Build HIVE-MIND or HyperAgents native chat through resolved Cordis profiles, scoped plugins, typed tools, and durable projections.
---

# Cordis Harness workflow

Read `../../platform.yaml`, `../../capability-contracts.md`, and the local
`cordis-first-harness` skill before changing a runner.

1. Verify the resolved profile and ordered bundles. A package absent from the
   resolved profile is not part of the application.
2. Select the narrowest Cordis seam: service, typed tool, session event/projection,
   plugin, or profile mode.
3. Keep common native runner behavior shared. Express HIVE-MIND Chat and
   HyperAgents differences through mode-specific profile/plugin composition.
4. Return a bounded typed model projection and retain private full receipts in a
   durable authorized service.
5. Keep completed workflows terminal and out of later prompt assembly.
6. Test profile resolution, plugin lifecycle, authorization, cancellation/resume,
   refresh/replay, and native UI rendering.
7. Use a targeted runner refresh for local/Enigma development output. Build an
   immutable image only for the verified release.

Do not rewrite the Harness agent loop, patch generated bundles, use a temporary
spill location as receipt storage, or hide native failure behind legacy routing.
