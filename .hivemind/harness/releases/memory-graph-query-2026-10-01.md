# Memory Graph query release

- Frontend: `cbc31b4957c78739fab2466ee49f9aa3bcc992a8` (Da-vinci main).
- Parent gitlink promotion: `5f57c98a`.
- Production Worker: `hivemind-web`.
- Active version: `59c5fd99-742c-4b9a-ade7-35f405c2fea8`.
- Previous version: `9cdbf945-8264-4522-b535-aa78f205580a`.
- Before this feature: `87a41d94-3854-47a6-a568-014d29695db6`.
- Bundle: `main.85fd5179.js`.

The graph has a floating query input and one send button, directly over the
canvas with no bottom strip or reserved footer. It calls the existing
authorized `/v1/proxy/recall` endpoint in quick mode with limit 25 and live
connector retrieval disabled. It highlights returned memories, dims unrelated
nodes, frames up to five matches, and exposes clickable titles for those matches.
Recalled memories outside the current node budget are merged into the graph;
only updates, extends, derives, and contradictions are drawn.

The bottom timeline is presentation-disabled by `SHOW_GRAPH_TIMELINE`; its
controls and temporal implementation remain in source.

Checks: production React build, asset-pruning contract (1071 files), clean source
release assertion, public graph route HTTP 200, and authenticated browser recall.
The fundraising query returned one relevant memory. An initial over-close camera
fit was corrected with a bounded camera distance. No Core or Harness runtime
was rebuilt for this frontend release.
