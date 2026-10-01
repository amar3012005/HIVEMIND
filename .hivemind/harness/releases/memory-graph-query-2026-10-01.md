# Memory Graph query release

- Frontend: `dd04b30305f22ef66b3f90306bafe9b52ceabbba` (Da-vinci main).
- Parent gitlink promotion: `c8dd6a15`.
- Production Worker: `hivemind-web`.
- Active version: `5098c78a-bc12-479c-be23-76e854451c78`.
- Previous version: `59c5fd99-742c-4b9a-ade7-35f405c2fea8`.
- Before this feature: `87a41d94-3854-47a6-a568-014d29695db6`.
- Bundle: `main.cc8b8bf7.js`.

The graph has a floating query input and one send button, directly over the
canvas with no bottom strip or reserved footer. It calls the existing
authorized `/v1/proxy/recall` endpoint in quick mode with limit 25 and live
connector retrieval disabled. It highlights returned memories, dims unrelated
nodes, frames up to five matches, and exposes clickable titles for those matches.
Recalled memories outside the current node budget are merged into the graph;
only updates, extends, derives, and contradictions are drawn.

The query box stays centered across the full page, independently of inspector
visibility. The inspector leaves 160px bottom clearance so it cannot cover the
composer or its result row. Browser screenshots confirmed the composer position
is unchanged when opening and closing the inspector.

The bottom timeline is presentation-disabled by `SHOW_GRAPH_TIMELINE`; its
controls and temporal implementation remain in source.

Checks: production React build, asset-pruning contract (1071 files), clean source
release assertion, public graph route HTTP 200, and authenticated browser recall.
The fundraising query returned one relevant memory. An initial over-close camera
fit was corrected with a bounded camera distance. No Core or Harness runtime
was rebuilt for this frontend release.
